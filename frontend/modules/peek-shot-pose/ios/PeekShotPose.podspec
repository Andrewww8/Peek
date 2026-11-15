Pod::Spec.new do |spec|
  spec.name = 'PeekShotPose'
  spec.version = '1.0.0'
  spec.summary = 'Analyzes basketball clips on iPhone using Vision.'
  spec.homepage = 'https://github.com/Andrewww8/Peek'
  spec.author = 'Peek'
  spec.license = { type: 'Proprietary' }
  spec.source = { git: 'https://github.com/Andrewww8/Peek.git' }
  spec.platform = :ios, '16.4'
  spec.swift_version = '5.9'
  spec.static_framework = true
  spec.dependency 'ExpoModulesCore'
  spec.frameworks = 'AVFoundation', 'Vision'
  spec.source_files = '*.swift'
end
