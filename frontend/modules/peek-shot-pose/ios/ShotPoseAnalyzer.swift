import AVFoundation
import Foundation
import Vision

enum ShotPoseError: LocalizedError {
  case unsupportedSystem
  case invalidRecording
  case invalidRelease

  var errorDescription: String? {
    switch self {
    case .unsupportedSystem:
      return "On-device shot analysis requires iOS 17 or later."
    case .invalidRecording:
      return "The original recording could not be opened."
    case .invalidRelease:
      return "Mark the release within the recording and try again."
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

  static func frames(uri: String, releaseMs: Double) async throws -> [[String: Any]] {
    guard let url = URL(string: uri), url.isFileURL else {
      throw ShotPoseError.invalidRecording
    }
    guard releaseMs.isFinite, releaseMs >= 0 else {
      throw ShotPoseError.invalidRelease
    }

    let asset = AVURLAsset(url: url)
    guard let length = try? await asset.load(.duration), length.seconds.isFinite, length.seconds > 0 else {
      throw ShotPoseError.invalidRecording
    }
    let release = releaseMs / 1000
    guard release <= length.seconds + 0.001 else {
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
      let seconds = release + Double(index - 24) / 30
      guard seconds >= 0, seconds < length.seconds else { continue }
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
