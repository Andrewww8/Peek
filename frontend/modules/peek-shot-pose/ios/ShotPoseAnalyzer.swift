import AVFoundation
import Foundation
import Vision

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

    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.maximumSize = CGSize(width: 960, height: 960)
    // Forty-two ms is a full frame at 24 fps. Limiting tolerance to 33 ms
    // keeps the sampled pose close to each point of the 30 fps comparison.
    let tolerance = CMTime(value: 1, timescale: 30)
    generator.requestedTimeToleranceBefore = tolerance
    generator.requestedTimeToleranceAfter = tolerance

    var frames: [[String: Any]] = []
    var lastTime: CMTime?
    for index in stride(from: 0, through: 36, by: 2) {
      try Task.checkCancellation()
      defer { progress(Double(index / 2 + 1) / 19) }
      let seconds = release + Double(index - 24) / 30
      guard seconds >= 0, seconds < duration else { continue }
      let requestedTime = CMTime(seconds: seconds, preferredTimescale: 600)
      guard let frame = try? await generator.image(at: requestedTime),
            frame.actualTime.isNumeric,
            abs(frame.actualTime.seconds - seconds) <= tolerance.seconds + 0.001,
            lastTime.map({ CMTimeCompare($0, frame.actualTime) < 0 }) ?? true else { continue }
      lastTime = frame.actualTime

      let joints: [Any]? = try autoreleasepool {
        let request = VNDetectHumanBodyPose3DRequest()
        let handler = VNImageRequestHandler(cgImage: frame.image, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.max(by: { $0.confidence < $1.confidence }) else { return nil }
        return jointNames.flatMap { joint -> [Any] in
          guard let position = try? observation.cameraRelativePosition(joint).columns.3,
                position.x.isFinite, position.y.isFinite, position.z.isFinite else {
            return [NSNull(), NSNull(), NSNull()]
          }
          return [Double(position.x), Double(position.y), Double(position.z)]
        }
      }
      if let joints {
        frames.append(["index": index, "joints": joints])
      }
    }
    return frames
  }
}
