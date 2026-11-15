import ExpoModulesCore

public final class PeekShotPoseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PeekShotPose")
    Events("onShotPoseProgress")

    Function("isAvailable") {
      if #available(iOS 17.0, *) { return true }
      return false
    }

    AsyncFunction("detectRelease") { (uri: String, requestId: String?) async throws -> Double in
      guard #available(iOS 17.0, *) else {
        throw ShotPoseError.unsupportedSystem
      }
      return try await AutomaticReleaseDetector.releaseMs(uri: uri) { progress in
        self.reportProgress(requestId, operation: "detectRelease", progress: progress)
      }
    }

    AsyncFunction("analyze") { (uri: String, releaseMs: Double, requestId: String?) async throws -> [String: Any] in
      guard #available(iOS 17.0, *) else {
        throw ShotPoseError.unsupportedSystem
      }
      let frames = try await ShotPoseAnalyzer.frames(uri: uri, releaseMs: releaseMs) { progress in
        self.reportProgress(requestId, operation: "analyze", progress: progress)
      }
      return ["frames": frames, "trackingVersion": 7]
    }
  }

  private func reportProgress(_ requestId: String?, operation: String, progress: Double) {
    guard let requestId else { return }
    sendEvent("onShotPoseProgress", ["requestId": requestId, "operation": operation, "progress": progress])
  }
}
