import AVFoundation
import Foundation
import Vision

@available(iOS 17.0, *)
enum AutomaticReleaseDetector {
  private typealias Joint = VNHumanBodyPoseObservation.JointName

  private struct Arm {
    let wristAboveHead: Double
    let wristAboveElbow: Double
    let extensionDegrees: Double
    let confidence: Double
  }

  private struct Sample {
    let time: Double
    let root: CGPoint
    let torso: Double
    let quality: Double
    let left: Arm?
    let right: Arm?

    func matches(_ other: Sample) -> Bool {
      let allowedTorsoLengths = 0.65 + 2 * abs(time - other.time)
      return root.distance(to: other.root) < max(torso, other.torso) * allowedTorsoLengths
        && max(torso, other.torso) < min(torso, other.torso) * 1.7
    }
  }

  private struct Candidate {
    let time: Double
    let score: Double
  }

  static func releaseMs(uri: String, progress: (Double) -> Void = { _ in }) async throws -> Double {
    let (asset, duration) = try await ShotPoseAnalyzer.recording(uri: uri)
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 640, height: 640)
    let tolerance = CMTime(value: 1, timescale: 30)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance
    let request = VNDetectHumanBodyPoseRequest()

    let coarse = try await scan(
      from: 0, to: duration, interval: 1.0 / 12, generator: generator, request: request
    ) { progress($0 * 0.8) }
    guard let likely = findCandidate(in: coarse, duration: duration) else {
      throw ShotPoseError.releaseNotFound
    }

    let fine = try await scan(
      from: max(0, likely.time - 0.85), to: min(duration, likely.time + 0.36),
      interval: 1.0 / 30, generator: generator, request: request
    ) { progress(0.8 + $0 * 0.2) }
    let refined = findCandidate(
      in: fine, duration: duration, near: (likely.time - 0.22)...(likely.time + 0.22)
    )
    return ((refined ?? likely).time * 1_000).rounded()
  }

  private static func scan(
    from start: Double, to end: Double, interval: Double,
    generator: AVAssetImageGenerator, request: VNDetectHumanBodyPoseRequest,
    progress: (Double) -> Void
  ) async throws -> [Sample] {
    let count = max(1, Int(ceil((end - start) / interval)))
    var samples: [Sample] = []
    var lastTime = -Double.infinity
    for index in 0..<count {
      try Task.checkCancellation()
      // Publish at a bounded rate even when a frame can't be decoded or has no usable pose.
      defer {
        if index % 3 == 0 || index == count - 1 {
          progress(Double(index + 1) / Double(count))
        }
      }
      let time = CMTime(seconds: start + Double(index) * interval, preferredTimescale: 600)
      guard let frame = try? await generator.image(at: time), frame.actualTime.isNumeric,
            frame.actualTime.seconds > lastTime else { continue }
      lastTime = frame.actualTime.seconds
      let previous = samples.last
      let tracked: Sample? = try autoreleasepool {
        let handler = VNImageRequestHandler(cgImage: frame.image, orientation: .up, options: [:])
        try handler.perform([request])
        let aspect = Double(frame.image.width) / Double(frame.image.height)
        let detections = (request.results ?? []).compactMap { observation in
          sample(from: observation, time: lastTime, aspect: aspect)
        }
        func priority(_ detection: Sample) -> Double {
          let continuesTrack = previous.map { lastTime - $0.time <= 0.3 && detection.matches($0) } ?? false
          return detection.quality * (continuesTrack ? 1.3 : 1)
        }
        return detections.max { priority($0) < priority($1) }
      }
      if let tracked {
        samples.append(tracked)
      }
    }
    return samples
  }

  private static func sample(from observation: VNHumanBodyPoseObservation, time: Double, aspect: Double) -> Sample? {
    guard let points = try? observation.recognizedPoints(.all) else { return nil }
    func point(_ joint: Joint, minimumConfidence: Float = 0.25) -> (position: CGPoint, confidence: Double)? {
      guard let value = points[joint], value.confidence >= minimumConfidence else { return nil }
      return (CGPoint(x: value.x * aspect, y: value.y), Double(value.confidence))
    }
    guard let root = point(.root), let neck = point(.neck) else { return nil }
    let torso = neck.position.distance(to: root.position)
    guard torso >= 0.04 else { return nil }
    let headY = point(.nose)?.position.y ?? neck.position.y + 0.25 * torso

    func arm(shoulder: Joint, elbow: Joint, wrist: Joint) -> Arm? {
      guard let s = point(shoulder), let e = point(elbow), let w = point(wrist),
            let bend = e.position.angle(from: s.position, to: w.position) else { return nil }
      return Arm(
        wristAboveHead: (w.position.y - headY) / torso,
        wristAboveElbow: (w.position.y - e.position.y) / torso,
        extensionDegrees: bend,
        confidence: (s.confidence + e.confidence + w.confidence) / 3
      )
    }
    return Sample(
      time: time,
      root: root.position,
      torso: torso,
      quality: torso * sqrt(root.confidence * neck.confidence),
      left: arm(shoulder: .leftShoulder, elbow: .leftElbow, wrist: .leftWrist),
      right: arm(shoulder: .rightShoulder, elbow: .rightElbow, wrist: .rightWrist)
    )
  }

  private static func findCandidate(
    in samples: [Sample], duration: Double, near range: ClosedRange<Double>? = nil
  ) -> Candidate? {
    let strongestBody = samples.map(\.quality).max() ?? 0
    var best: Candidate?
    for (index, sample) in samples.enumerated() {
      guard range?.contains(sample.time) ?? true, sample.quality >= strongestBody * 0.5 else { continue }
      let before = samples[..<index].reversed().prefix { sample.time - $0.time <= 0.65 }
      let after = samples[(index + 1)...].prefix { $0.time - sample.time <= 0.20 }
      for side: KeyPath<Sample, Arm?> in [\.left, \.right] {
        guard let arm = sample[keyPath: side],
              arm.wristAboveHead >= 0.18, arm.wristAboveElbow >= 0.22,
              arm.extensionDegrees >= 135 else { continue }

        // A shot rises from a bent arm into an extended arm near the wrist's local peak.
        let setPoint = before.first { prior in
          guard sample.time - prior.time >= 0.07, sample.matches(prior), let bent = prior[keyPath: side] else { return false }
          return arm.wristAboveHead - bent.wristAboveHead >= 0.35
            && arm.extensionDegrees - bent.extensionDegrees >= 28
        }
        guard let setPoint else { continue }
        let followThrough = after.filter { sample.matches($0) }.compactMap { $0[keyPath: side] }
        guard followThrough.contains(where: { $0.wristAboveHead >= 0.05 && $0.extensionDegrees >= 115 })
          || duration - sample.time < 0.10 else { continue }
        guard !followThrough.contains(where: { $0.wristAboveHead > arm.wristAboveHead + 0.12 }) else { continue }

        let timeFromSet = sample.time - setPoint.time
        let score = arm.wristAboveHead
          + 0.35 * (arm.extensionDegrees - 135) / 45
          + 0.25 * arm.confidence + 0.2 * sample.quality / strongestBody - timeFromSet
        if score > (best?.score ?? -Double.infinity) {
          best = Candidate(time: sample.time, score: score)
        }
      }
    }
    return best
  }
}

private extension CGPoint {
  func distance(to point: CGPoint) -> Double {
    hypot(x - point.x, y - point.y)
  }

  func angle(from a: CGPoint, to b: CGPoint) -> Double? {
    let length = distance(to: a) * distance(to: b)
    guard length > 0.00001 else { return nil }
    let cosine = ((a.x - x) * (b.x - x) + (a.y - y) * (b.y - y)) / length
    return acos(max(-1, min(1, cosine))) * 180 / .pi
  }
}
