import AVFoundation
import Foundation
import Vision
import simd

enum ShotPoseError: LocalizedError {
  case unsupportedSystem
  case invalidRecording
  case invalidRelease
  case releaseNotFound

  var errorDescription: String? {
    switch self {
    case .unsupportedSystem:
      return "On-device shot analysis requires iOS 17 or later."
    case .invalidRecording:
      return "The original recording could not be opened."
    case .invalidRelease:
      return "Mark the release within the recording and try again."
    case .releaseNotFound:
      return "Peek couldn’t find a clear shot release. Mark the release for this clip or try a recording with the shooter in view."
    }
  }
}

@available(iOS 17.0, *)
enum ShotPoseAnalyzer {
  // Human3.6M order, shared with the NBA reference poses.
  static let jointNames: [VNHumanBodyPose3DObservation.JointName] = [
    .root, .rightHip, .rightKnee, .rightAnkle, .leftHip, .leftKnee, .leftAnkle,
    .spine, .centerShoulder, .centerHead, .topHead,
    .leftShoulder, .leftElbow, .leftWrist, .rightShoulder, .rightElbow, .rightWrist
  ]

  private static func jumpSample(
    request: VNDetectHumanBodyPoseRequest,
    handler: VNImageRequestHandler,
    image: CGImage,
    near projectedRoot: SIMD2<Double>?
  ) -> [Any] {
    let missing = Array<Any>(repeating: NSNull(), count: 4)
    // Use source-image landmarks rather than projections of the 3D pose to measure foot lift.
    guard let projectedRoot, (try? handler.perform([request])) != nil else { return missing }
    let aspect = Double(image.width) / Double(image.height)
    let target = projectedRoot / Double(image.height)
    let candidates = (request.results ?? []).compactMap { observation -> (distance: Double, sample: [Double?])? in
      guard let points = try? observation.recognizedPoints(.all) else { return nil }
      func point(_ joint: VNHumanBodyPoseObservation.JointName) -> SIMD2<Double>? {
        guard let point = points[joint], point.confidence >= 0.3,
              (0...1).contains(point.x), (0...1).contains(point.y) else { return nil }
        return SIMD2(Double(point.x) * aspect, Double(point.y))
      }
      func center(
        _ left: VNHumanBodyPoseObservation.JointName,
        _ right: VNHumanBodyPoseObservation.JointName,
        fallback: VNHumanBodyPoseObservation.JointName
      ) -> SIMD2<Double>? {
        if let a = point(left), let b = point(right) { return (a + b) / 2 }
        return point(fallback)
      }
      guard let pelvis = center(.leftHip, .rightHip, fallback: .root),
            let shoulders = center(.leftShoulder, .rightShoulder, fallback: .neck) else { return nil }
      let torsoLength = simd_distance(pelvis, shoulders)
      let distance = simd_distance(target, pelvis)
      guard torsoLength >= 0.04, distance <= torsoLength * 0.75 else { return nil }

      let rightAnkle = point(.rightAnkle)
      let leftAnkle = point(.leftAnkle)
      // The ankle and pelvis heights increase upward. Torso length uses image-height units.
      return (distance, [rightAnkle?.y, leftAnkle?.y, pelvis.y, torsoLength])
    }
    guard let nearest = candidates.min(by: { $0.distance < $1.distance }) else { return missing }
    return nearest.sample.map { value in value.map { $0 as Any } ?? NSNull() }
  }

  static func recording(uri: String) async throws -> (AVURLAsset, Double) {
    guard let url = URL(string: uri), url.isFileURL else {
      throw ShotPoseError.invalidRecording
    }
    let asset = AVURLAsset(url: url)
    let duration = try? await asset.load(.duration).seconds
    guard let duration, duration.isFinite, duration > 0 else {
      throw ShotPoseError.invalidRecording
    }
    return (asset, duration)
  }

  static func frames(uri: String, releaseMs: Double, progress: (Double) -> Void = { _ in }) async throws -> [[String: Any]] {
    guard releaseMs.isFinite, releaseMs >= 0 else {
      throw ShotPoseError.invalidRelease
    }

    let (asset, duration) = try await recording(uri: uri)
    let release = releaseMs / 1000
    guard release <= duration + 0.001 else {
      throw ShotPoseError.invalidRelease
    }
    guard let videoTrack = try await asset.loadTracks(withMediaType: .video).first else {
      throw ShotPoseError.invalidRecording
    }
    let videoRange = try await videoTrack.load(.timeRange)
    let videoStart = max(0, videoRange.start.seconds)
    let videoEnd = min(duration, videoRange.end.seconds)

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 960, height: 960)
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero

    var frames: [[String: Any]] = []
    var lastTime: CMTime?
    let jumpRequest = VNDetectHumanBodyPoseRequest()
    let releaseIndex = 24
    let fps = 30
    let lastIndex = releaseIndex + fps
    let windowEnd = release + 1
    // The asset can have audio beyond its last image. Sample just inside the video end
    // if the clip ends between regular samples instead of losing its final pose.
    let finalTime = min(windowEnd, videoEnd - 0.0001)
    var times = stride(from: 0, through: lastIndex, by: 2)
      .map { release + Double($0 - releaseIndex) / Double(fps) }
      .filter { $0 >= videoStart && $0 <= finalTime }
    if finalTime >= videoStart && finalTime > (times.last ?? -.infinity) + 0.0001 {
      times.append(finalTime)
    }

    for (step, seconds) in times.enumerated() {
      try Task.checkCancellation()
      defer { progress(Double(step + 1) / Double(times.count)) }
      let requestedTime = CMTime(seconds: seconds, preferredTimescale: 60_000)
      guard let frame = try? await generator.image(at: requestedTime),
            frame.actualTime.isNumeric,
            frame.actualTime.seconds <= windowEnd,
            lastTime.map({ CMTimeCompare($0, frame.actualTime) < 0 }) ?? true else { continue }
      lastTime = frame.actualTime
      let index = min(lastIndex, max(0, releaseIndex + Int(((frame.actualTime.seconds - release) * Double(fps)).rounded())))

      let sample: [String: Any]? = try autoreleasepool {
        let request = VNDetectHumanBodyPose3DRequest()
        let handler = VNImageRequestHandler(cgImage: frame.image, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.max(by: { $0.confidence < $1.confidence }) else { return nil }
        let joints = jointNames.flatMap { joint -> [Any] in
          guard let position = try? observation.cameraRelativePosition(joint).columns.3,
                position.x.isFinite, position.y.isFinite, position.z.isFinite else {
            return [NSNull(), NSNull(), NSNull()]
          }
          return [Double(position.x), Double(position.y), Double(position.z)]
        }
        let pelvisInImage = (try? observation.pointInImage(.root).location).map { point in
          SIMD2(Double(point.x) * Double(frame.image.width), Double(point.y) * Double(frame.image.height))
        }
        return ["index": index, "joints": joints,
                "jumpSample": jumpSample(request: jumpRequest, handler: handler, image: frame.image, near: pelvisInImage)]
      }
      if let sample {
        frames.append(sample)
      }
    }
    return frames
  }
}
