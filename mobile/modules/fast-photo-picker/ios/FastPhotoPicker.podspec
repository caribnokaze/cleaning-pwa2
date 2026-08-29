Pod::Spec.new do |spec|
  spec.name           = 'FastPhotoPicker'
  spec.version        = '1.0.0'
  spec.summary        = 'Fast PhotoKit asset identifier picker for TOCORO.'
  spec.description    = 'A custom PhotoKit grid that returns selected PHAsset identifiers before loading full image data.'
  spec.license        = { :type => 'MIT' }
  spec.author         = 'TOCORO.'
  spec.homepage       = 'https://tocoro-report.com'
  spec.platforms      = { :ios => '16.4' }
  spec.swift_version  = '5.9'
  spec.source         = { :git => '' }
  spec.static_framework = true

  spec.dependency 'ExpoModulesCore'
  spec.frameworks = 'Photos', 'UIKit'
  spec.source_files = '**/*.swift'
end
