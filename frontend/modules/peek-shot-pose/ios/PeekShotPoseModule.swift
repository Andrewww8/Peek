import ExpoModulesCore

public final class PeekShotPoseModule: Module {
  public func definition() -> ModuleDefinition {
    Name("PeekShotPose")

    Function("isAvailable") {
      if #available(iOS 17.0, *) { return true }
      return false
    }

    AsyncFunction("analyze") { (uri: String, releaseMs: Double) async throws -> [String: [[String: Any]]] in
      guard #available(iOS 17.0, *) else {
        throw ShotPoseError.unsupportedSystem
      }
      return ["frames": try await ShotPoseAnalyzer.frames(uri: uri, releaseMs: releaseMs)]
    }
  }
}
