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

  private struct BodyJoint {
    let position: SIMD3<Double>?
    let image: SIMD2<Double>?
  }

  private struct Hand {
    let wrist: SIMD2<Double>
    let chirality: VNChirality
    let landmarks: [SIMD2<Double>?]
  }

  // Preserve the original three slots, then add the index finger's own knuckle.
  private static let handLandmarks: [VNHumanHandPoseObservation.JointName] = [
    .middleTip, .indexTip, .middleMCP, .indexMCP
  ]
  private static let wristIndices = [13, 16]

  private static func coordinates(_ point: SIMD3<Double>?) -> [Any] {
    guard let point else { return [NSNull(), NSNull(), NSNull()] }
    return [point.x, point.y, point.z]
  }

  private static func bodyJoints(_ body: VNHumanBodyPose3DObservation, in image: CGImage) -> [BodyJoint] {
    jointNames.map { name in
      let position = (try? body.cameraRelativePosition(name).columns.3).flatMap { value in
        value.x.isFinite && value.y.isFinite && value.z.isFinite
          ? SIMD3(Double(value.x), Double(value.y), Double(value.z)) : nil
      }
      let projected = (try? body.pointInImage(name).location).flatMap { value in
        value.x.isFinite && value.y.isFinite
          ? SIMD2(Double(value.x) * Double(image.width), Double(value.y) * Double(image.height)) : nil
      }
      return BodyJoint(position: position, image: projected)
    }
  }

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

  private static func pixelsPerMeter(_ joints: [BodyJoint]) -> Double? {
    let projected = joints.compactMap { joint -> (camera: SIMD2<Double>, image: SIMD2<Double>)? in
      guard let position = joint.position, let image = joint.image else { return nil }
      return (SIMD2(position.x, position.y), image)
    }
    guard projected.count >= 4 else { return nil }
    let count = Double(projected.count)
    let cameraCenter = projected.reduce(SIMD2<Double>.zero) { $0 + $1.camera } / count
    let imageCenter = projected.reduce(SIMD2<Double>.zero) { $0 + $1.image } / count
    var covariance = 0.0
    var spread = 0.0
    for joint in projected {
      let offset = joint.camera - cameraCenter
      covariance += simd_dot(offset, joint.image - imageCenter)
      spread += simd_length_squared(offset)
    }
    let scale = covariance / spread
    return scale.isFinite && scale > 0 ? scale : nil
  }

  private static func detectHands(in image: CGImage, near wrists: [SIMD2<Double>], padding: Double) -> [Hand] {
    let xs = wrists.map(\.x), ys = wrists.map(\.y)
    guard let left = xs.min(), let right = xs.max(), let bottom = ys.min(), let top = ys.max() else { return [] }
    // Vision points start at the lower left. CGImage crop rectangles start at the upper left.
    let crop = CGRect(x: left - padding, y: Double(image.height) - top - padding,
                      width: right - left + 2 * padding, height: top - bottom + 2 * padding)
      .integral.intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
    guard !crop.isEmpty, let cropped = image.cropping(to: crop) else { return [] }
    let request = VNDetectHumanHandPoseRequest()
    request.maximumHandCount = 4
    let handler = VNImageRequestHandler(cgImage: cropped, orientation: .up, options: [:])
    do { try handler.perform([request]) } catch { return [] }
    return (request.results ?? []).compactMap { observation in
      func point(_ name: VNHumanHandPoseObservation.JointName) -> SIMD2<Double>? {
        guard let point = try? observation.recognizedPoint(name), point.confidence >= 0.25,
              (0...1).contains(point.location.x), (0...1).contains(point.location.y) else { return nil }
        return SIMD2(Double(crop.minX + point.location.x * crop.width),
                     Double(CGFloat(image.height) - crop.maxY + point.location.y * crop.height))
      }
      guard let wrist = point(.wrist) else { return nil }
      let landmarks = handLandmarks.map { point($0) }
      guard landmarks.contains(where: { $0 != nil }) else { return nil }
      return Hand(wrist: wrist, chirality: observation.chirality, landmarks: landmarks)
    }
  }

  private static func matchHands(_ hands: [Hand], to wrists: [SIMD2<Double>?], bodyHeight: Double) -> [Hand?] {
    // Assign detections jointly so only one side uses a hand when the wrists overlap at release.
    let options: [Int?] = [nil] + hands.indices.map(Optional.some)
    let maxDistance = bodyHeight * 0.10
    func cost(_ hand: Int?, side: Int) -> Double {
      guard let hand else { return maxDistance }
      guard let wrist = wrists[side] else { return .infinity }
      let distance = simd_distance(hands[hand].wrist, wrist)
      guard distance <= maxDistance else { return .infinity }
      let expected: VNChirality = side == 0 ? .left : .right
      let otherSide = hands[hand].chirality != .unknown && hands[hand].chirality != expected
      if otherSide, let alternate = wrists[1 - side],
         simd_distance(hands[hand].wrist, alternate) <= min(maxDistance, distance + bodyHeight * 0.03) {
        return .infinity
      }
      return distance + (otherSide ? bodyHeight * 0.02 : 0)
    }
    var result: [Hand?] = [nil, nil]
    var best = Double.infinity
    for left in options {
      for right in options where left == nil || left != right {
        let score = cost(left, side: 0) + cost(right, side: 1)
        if score < best {
          best = score
          result = [left.map { hands[$0] }, right.map { hands[$0] }]
        }
      }
    }
    return result
  }

  private static func fittedHand(_ hand: Hand, wrist: SIMD3<Double>, elbow: SIMD3<Double>?,
                                 pixelsPerMeter: Double, bodyHeight: Double) -> [SIMD3<Double>?] {
    let forearm = wrist - (elbow ?? wrist)
    let imageDirection = SIMD2(forearm.x, forearm.y)
    let visibleLength = simd_length(imageDirection)
    // The image gives the shape of the hand. Use a single gently tilted plane for all
    // landmarks so individually guessed depths cannot stretch or cross the fingers.
    let slope = max(-0.65, min(0.65, forearm.z / max(1e-6, visibleLength)))
    let gradient = visibleLength > 1e-6 ? imageDirection * (slope / visibleLength) : .zero
    var offsets = hand.landmarks.enumerated().map { index, landmark -> SIMD3<Double>? in
      guard let landmark else { return nil }
      let imageOffset = (landmark - hand.wrist) / pixelsPerMeter
      let offset = SIMD3(imageOffset.x, imageOffset.y, simd_dot(imageOffset, gradient))
      let maxRadius = (index < 2 ? 0.15 : 0.085) * bodyHeight
      return simd_length(offset) <= maxRadius ? offset : nil
    }
    for finger in 0..<2 {
      guard let tip = offsets[finger], let base = offsets[finger + 2],
            simd_distance(tip, base) <= bodyHeight * 0.09 else {
        offsets[finger] = nil
        continue
      }
    }
    return offsets.map { offset in offset.map { wrist + $0 } }
  }

  private static func handPoints(_ joints: [BodyJoint], bodyHeight: Double, image: CGImage) -> [Any] {
    let empty = Array<Any>(repeating: NSNull(), count: handLandmarks.count * 2 * 3)
    let wrists = wristIndices.map { joints[$0].image }
    guard let scale = pixelsPerMeter(joints), bodyHeight.isFinite, bodyHeight > 0 else { return empty }
    let bodyPixels = bodyHeight * scale
    let visibleWrists = wrists.compactMap { $0 }
    var hands = detectHands(in: image, near: visibleWrists, padding: max(28, bodyPixels * 0.24))
    var matches = matchHands(hands, to: wrists, bodyHeight: bodyPixels)
    // A wrist-centered crop gives the hand model a closer view when the shared crop misses a hand.
    for (side, wrist) in wrists.enumerated() where matches[side] == nil {
      guard let wrist else { continue }
      for hand in detectHands(in: image, near: [wrist], padding: max(22, bodyPixels * 0.17)) {
        let equivalent = hands.firstIndex { simd_distance(hand.wrist, $0.wrist) < bodyPixels * 0.03 }
        if let equivalent {
          if hand.landmarks.compactMap({ $0 }).count > hands[equivalent].landmarks.compactMap({ $0 }).count {
            hands[equivalent] = hand
          }
        } else {
          hands.append(hand)
        }
      }
      matches = matchHands(hands, to: wrists, bodyHeight: bodyPixels)
    }

    let positioned = wristIndices.enumerated().map { side, wristIndex -> [SIMD3<Double>?]? in
      guard let hand = matches[side], let wrist = joints[wristIndex].position else { return nil }
      return fittedHand(hand, wrist: wrist, elbow: joints[wristIndex - 1].position,
                        pixelsPerMeter: scale, bodyHeight: bodyHeight)
    }
    return handLandmarks.indices.flatMap { landmark in
      positioned.flatMap { coordinates($0?[landmark] ?? nil) }
    }
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
    // Use each video frame around release, where the ball can briefly hide either hand.
    var times = (0...lastIndex).filter { $0.isMultiple(of: 2) || abs($0 - releaseIndex) <= 6 }
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
        let joints = bodyJoints(observation, in: frame.image)
        return ["index": index, "joints": joints.flatMap { coordinates($0.position) },
                "fingers": handPoints(joints, bodyHeight: Double(observation.bodyHeight), image: frame.image),
                "jumpSample": jumpSample(request: jumpRequest, handler: handler, image: frame.image, near: joints.first?.image)]
      }
      if let sample {
        frames.append(sample)
      }
    }
    return frames
  }
}
