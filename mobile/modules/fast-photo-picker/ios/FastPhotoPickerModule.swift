import ExpoModulesCore
import Photos
import PhotosUI
import UIKit

public final class FastPhotoPickerModule: Module {
  private var systemPickerDelegate: SystemPhotoPickerDelegate?

  public func definition() -> ModuleDefinition {
    Name("FastPhotoPicker")

    AsyncFunction("pickPhotos") { (limit: Int, promise: Promise) in
      DispatchQueue.main.async {
        PHPhotoLibrary.requestAuthorization(for: .readWrite) { status in
          DispatchQueue.main.async {
            guard status == .authorized || status == .limited else {
              promise.reject("ERR_PHOTO_PERMISSION", "写真へのアクセスが許可されていません")
              return
            }
            guard let presenter = Self.currentViewController() else {
              promise.reject("ERR_NO_VIEW_CONTROLLER", "写真選択画面を表示できません")
              return
            }

            let picker = PhotoGridViewController(limit: min(max(limit, 1), 100))
            let navigation = UINavigationController(rootViewController: picker)
            navigation.modalPresentationStyle = .fullScreen
            picker.onCancel = {
              navigation.dismiss(animated: true) {
                promise.resolve(["assetIds": [], "dismissalMs": 0])
              }
            }
            picker.onComplete = { assetIds, completedAt in
              navigation.dismiss(animated: true) {
                let elapsed = Int(Date().timeIntervalSince(completedAt) * 1000)
                promise.resolve(["assetIds": assetIds, "dismissalMs": elapsed])
              }
            }
            presenter.present(navigation, animated: true)
          }
        }
      }
    }

    AsyncFunction("pickPhotosWithSystemPicker") { (limit: Int, promise: Promise) in
      DispatchQueue.main.async { [weak self] in
        guard let self else { return }
        guard let presenter = Self.currentViewController() else {
          promise.reject("ERR_NO_VIEW_CONTROLLER", "写真選択画面を表示できません")
          return
        }

        var configuration = PHPickerConfiguration(photoLibrary: .shared())
        configuration.filter = .images
        configuration.selectionLimit = min(max(limit, 1), 100)
        configuration.selection = .ordered
        configuration.preferredAssetRepresentationMode = .current

        let picker = PHPickerViewController(configuration: configuration)
        let delegate = SystemPhotoPickerDelegate { [weak self, weak picker] assetIds, completedAt in
          guard let picker else {
            promise.reject("ERR_NO_VIEW_CONTROLLER", "写真選択画面を閉じられません")
            self?.systemPickerDelegate = nil
            return
          }
          picker.dismiss(animated: true) {
            let elapsed = assetIds.isEmpty
              ? 0
              : Int(Date().timeIntervalSince(completedAt) * 1000)
            promise.resolve(["assetIds": assetIds, "dismissalMs": elapsed])
            self?.systemPickerDelegate = nil
          }
        }
        self.systemPickerDelegate = delegate
        picker.delegate = delegate
        picker.modalPresentationStyle = .fullScreen
        presenter.present(picker, animated: true)
      }
    }

    AsyncFunction("preparePhotos") {
      (assetIds: [String], maxWidth: Double, jpegQuality: Double, promise: Promise) in
      let identifiers = Array(assetIds.prefix(100))
      let width = CGFloat(min(max(maxWidth, 1), 4096))
      let quality = CGFloat(min(max(jpegQuality, 0), 1))

      DispatchQueue.global(qos: .userInitiated).async {
        let startedAt = CFAbsoluteTimeGetCurrent()
        let assets = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
        var assetsById: [String: PHAsset] = [:]
        assets.enumerateObjects { asset, _, _ in
          assetsById[asset.localIdentifier] = asset
        }

        let group = DispatchGroup()
        let concurrency = DispatchSemaphore(value: 2)
        let resultLock = NSLock()
        var preparedCount = 0
        var sourceBytes = 0
        var outputBytes = 0

        for identifier in identifiers {
          guard let asset = assetsById[identifier] else { continue }
          group.enter()
          DispatchQueue.global(qos: .userInitiated).async {
            concurrency.wait()
            defer {
              concurrency.signal()
              group.leave()
            }

            autoreleasepool {
              guard let sourceData = Self.loadLocalImageData(for: asset),
                    let image = UIImage(data: sourceData),
                    let jpegData = Self.resizeAndCompress(
                      image: image,
                      maxWidth: width,
                      quality: quality
                    ) else { return }

              resultLock.lock()
              preparedCount += 1
              sourceBytes += sourceData.count
              outputBytes += jpegData.count
              resultLock.unlock()
            }
          }
        }

        group.notify(queue: .main) {
          let totalMs = Int((CFAbsoluteTimeGetCurrent() - startedAt) * 1000)
          promise.resolve([
            "requestedCount": identifiers.count,
            "preparedCount": preparedCount,
            "failedCount": identifiers.count - preparedCount,
            "totalMs": totalMs,
            "sourceBytes": sourceBytes,
            "outputBytes": outputBytes,
          ])
        }
      }
    }

    AsyncFunction("prepareAndUploadPhotos") {
      (assetIds: [String], uploadUrls: [String], maxWidth: Double,
       jpegQuality: Double, simulationMode: String, promise: Promise) in
      let count = min(min(assetIds.count, uploadUrls.count), 100)
      guard count > 0 else {
        promise.reject("ERR_EMPTY_UPLOAD", "アップロード対象がありません")
        return
      }
      let identifiers = Array(assetIds.prefix(count))
      let targets = Array(uploadUrls.prefix(count))
      guard targets.allSatisfy({ URL(string: $0)?.scheme == "https" }) else {
        promise.reject("ERR_INVALID_UPLOAD_URL", "アップロードURLが正しくありません")
        return
      }
      let width = CGFloat(min(max(maxWidth, 1), 4096))
      let quality = CGFloat(min(max(jpegQuality, 0), 1))

      DispatchQueue.global(qos: .userInitiated).async {
        let totalStartedAt = CFAbsoluteTimeGetCurrent()
        let preparationStartedAt = CFAbsoluteTimeGetCurrent()
        let temporaryDirectory = FileManager.default.temporaryDirectory
          .appendingPathComponent("tocoro-upload-\(UUID().uuidString)", isDirectory: true)
        do {
          try FileManager.default.createDirectory(
            at: temporaryDirectory,
            withIntermediateDirectories: true
          )
        } catch {
          promise.reject("ERR_TEMP_DIRECTORY", "一時ファイルを準備できません")
          return
        }

        let assets = PHAsset.fetchAssets(withLocalIdentifiers: identifiers, options: nil)
        var assetsById: [String: PHAsset] = [:]
        assets.enumerateObjects { asset, _, _ in assetsById[asset.localIdentifier] = asset }
        let prepareGroup = DispatchGroup()
        let prepareConcurrency = DispatchSemaphore(value: 2)
        let resultLock = NSLock()
        var preparedFiles: [Int: (url: URL, size: Int)] = [:]
        var failedIndexes: [Int] = []
        var firstError = ""

        for (index, identifier) in identifiers.enumerated() {
          guard let asset = assetsById[identifier] else {
            resultLock.lock()
            if firstError.isEmpty { firstError = "写真IDを読み込めません" }
            failedIndexes.append(index)
            resultLock.unlock()
            continue
          }
          prepareGroup.enter()
          DispatchQueue.global(qos: .userInitiated).async {
            prepareConcurrency.wait()
            defer { prepareConcurrency.signal(); prepareGroup.leave() }
            autoreleasepool {
              guard let sourceData = Self.loadLocalImageData(for: asset),
                    let image = UIImage(data: sourceData),
                    let jpegData = Self.resizeAndCompress(
                      image: image,
                      maxWidth: width,
                      quality: quality
                    ) else {
                resultLock.lock()
                if firstError.isEmpty { firstError = "端末内の写真原本を準備できません" }
                failedIndexes.append(index)
                resultLock.unlock()
                return
              }
              let fileURL = temporaryDirectory.appendingPathComponent(
                String(format: "%03d.jpg", index + 1)
              )
              do {
                try jpegData.write(to: fileURL, options: .atomic)
                resultLock.lock()
                preparedFiles[index] = (fileURL, jpegData.count)
                resultLock.unlock()
              } catch {
                resultLock.lock()
                if firstError.isEmpty { firstError = "一時JPEGを保存できません" }
                failedIndexes.append(index)
                resultLock.unlock()
              }
            }
          }
        }

        prepareGroup.wait()
        let preparationMs = Int(
          (CFAbsoluteTimeGetCurrent() - preparationStartedAt) * 1000
        )
        let uploadStartedAt = CFAbsoluteTimeGetCurrent()
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 60
        configuration.timeoutIntervalForResource = 300
        configuration.httpMaximumConnectionsPerHost = 4
        let session = URLSession(configuration: configuration)
        let uploadGroup = DispatchGroup()
        var uploadedCount = 0
        var uploadedBytes = 0
        var automaticRetryCount = 0
        let maxAutomaticRetries = 3

        for (index, file) in preparedFiles {
          guard let targetURL = URL(string: targets[index]) else { continue }
          uploadGroup.enter()
          var uploadAttempt: ((Int) -> Void)!
          uploadAttempt = { attempt in
            // ステージング実機試験専用。10枚ごとに全自動再試行を失敗させ、
            // JavaScript側の「失敗分だけ手動再送」を検証する。
            if simulationMode == "manual-retry" && (index + 1).isMultiple(of: 10) {
              if attempt < maxAutomaticRetries {
                resultLock.lock()
                automaticRetryCount += 1
                resultLock.unlock()
                DispatchQueue.global(qos: .userInitiated).asyncAfter(
                  deadline: .now() + (0.2 * pow(2.0, Double(attempt)))
                ) { uploadAttempt(attempt + 1) }
              } else {
                resultLock.lock()
                failedIndexes.append(index)
                if firstError.isEmpty { firstError = "ステージング用の通信失敗を再現しました" }
                resultLock.unlock()
                uploadGroup.leave()
              }
              return
            }

            var request = URLRequest(url: targetURL)
            request.httpMethod = "PUT"
            request.setValue("image/jpeg", forHTTPHeaderField: "Content-Type")
            session.uploadTask(with: request, fromFile: file.url) { _, response, error in
              let statusCode = (response as? HTTPURLResponse)?.statusCode
              if let statusCode, (200..<300).contains(statusCode) {
                resultLock.lock()
                uploadedCount += 1
                uploadedBytes += file.size
                resultLock.unlock()
                uploadGroup.leave()
                return
              }

              let retryableStatus = statusCode == 408 || statusCode == 429 ||
                (statusCode.map { (500..<600).contains($0) } ?? false)
              if attempt < maxAutomaticRetries && (error != nil || retryableStatus) {
                resultLock.lock()
                automaticRetryCount += 1
                resultLock.unlock()
                DispatchQueue.global(qos: .userInitiated).asyncAfter(
                  deadline: .now() + (0.2 * pow(2.0, Double(attempt)))
                ) { uploadAttempt(attempt + 1) }
                return
              }

              let detail = (error as NSError?).map {
                "\($0.domain) \($0.code): \($0.localizedDescription)"
              } ?? statusCode.map { "HTTP \($0)" } ?? "アップロード応答がありません"
              resultLock.lock()
              failedIndexes.append(index)
              if firstError.isEmpty { firstError = detail }
              resultLock.unlock()
              uploadGroup.leave()
            }.resume()
          }
          uploadAttempt(0)
        }

        uploadGroup.notify(queue: .main) {
          session.finishTasksAndInvalidate()
          try? FileManager.default.removeItem(at: temporaryDirectory)
          let uploadMs = Int((CFAbsoluteTimeGetCurrent() - uploadStartedAt) * 1000)
          promise.resolve([
            "requestedCount": count,
            "uploadedCount": uploadedCount,
            "failedCount": count - uploadedCount,
            "preparationMs": preparationMs,
            "uploadMs": uploadMs,
            "totalMs": Int((CFAbsoluteTimeGetCurrent() - totalStartedAt) * 1000),
            "uploadedBytes": uploadedBytes,
            "firstError": firstError,
            "failedIndexes": failedIndexes.sorted(),
            "automaticRetryCount": automaticRetryCount,
          ])
        }
      }
    }

  }

  private static func loadLocalImageData(for asset: PHAsset) -> Data? {
    let options = PHImageRequestOptions()
    options.deliveryMode = .highQualityFormat
    options.version = .current
    // 現場で撮影して端末に保存された原本だけを対象にする。
    // iCloudからの取得時間をベンチマークへ混ぜない。
    options.isNetworkAccessAllowed = false
    options.isSynchronous = true
    var result: Data?
    PHImageManager.default().requestImageDataAndOrientation(
      for: asset,
      options: options
    ) { data, _, _, _ in
      result = data
    }
    return result
  }

  private static func resizeAndCompress(
    image: UIImage,
    maxWidth: CGFloat,
    quality: CGFloat
  ) -> Data? {
    let sourceSize = image.size
    let scale = min(1, maxWidth / max(sourceSize.width, 1))
    let targetSize = CGSize(
      width: max(1, floor(sourceSize.width * scale)),
      height: max(1, floor(sourceSize.height * scale))
    )
    let format = UIGraphicsImageRendererFormat()
    format.scale = 1
    format.opaque = true
    let renderer = UIGraphicsImageRenderer(size: targetSize, format: format)
    let resized = renderer.image { _ in
      image.draw(in: CGRect(origin: .zero, size: targetSize))
    }
    return resized.jpegData(compressionQuality: quality)
  }

  private static func currentViewController() -> UIViewController? {
    let root = UIApplication.shared.connectedScenes
      .compactMap { $0 as? UIWindowScene }
      .flatMap(\.windows)
      .first { $0.isKeyWindow }?
      .rootViewController
    var current = root
    while let presented = current?.presentedViewController {
      current = presented
    }
    return current
  }
}

private final class SystemPhotoPickerDelegate: NSObject, PHPickerViewControllerDelegate {
  private let onFinish: ([String], Date) -> Void

  init(onFinish: @escaping ([String], Date) -> Void) {
    self.onFinish = onFinish
  }

  func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
    let completedAt = Date()
    let assetIds = results.compactMap(\.assetIdentifier)
    onFinish(assetIds, completedAt)
  }
}

private final class PhotoGridViewController: UIViewController,
  UICollectionViewDataSource,
  UICollectionViewDelegateFlowLayout,
  UIGestureRecognizerDelegate {
  var onCancel: (() -> Void)?
  var onComplete: (([String], Date) -> Void)?

  private let limit: Int
  private let imageManager = PHCachingImageManager()
  private var assets: PHFetchResult<PHAsset>!
  private var selectedIds: [String] = []
  private var collectionView: UICollectionView!
  private var dragShouldSelect = true
  private var dragVisitedIds: Set<String> = []
  private var latestDragLocation = CGPoint.zero
  private var autoScrollDisplayLink: CADisplayLink?
  private lazy var selectionPanGesture = UIPanGestureRecognizer(
    target: self,
    action: #selector(handleSelectionPan(_:))
  )
  private lazy var doneButton = UIBarButtonItem(
    title: "完了 (0)",
    style: .done,
    target: self,
    action: #selector(doneTapped)
  )

  init(limit: Int) {
    self.limit = limit
    super.init(nibName: nil, bundle: nil)
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func viewDidLoad() {
    super.viewDidLoad()
    title = "写真を選択"
    view.backgroundColor = .systemBackground
    navigationItem.leftBarButtonItem = UIBarButtonItem(
      title: "キャンセル",
      style: .plain,
      target: self,
      action: #selector(cancelTapped)
    )
    navigationItem.rightBarButtonItem = doneButton
    doneButton.isEnabled = false

    let options = PHFetchOptions()
    options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
    assets = PHAsset.fetchAssets(with: .image, options: options)

    let layout = UICollectionViewFlowLayout()
    layout.minimumInteritemSpacing = 2
    layout.minimumLineSpacing = 2
    collectionView = UICollectionView(frame: .zero, collectionViewLayout: layout)
    collectionView.backgroundColor = .systemBackground
    collectionView.dataSource = self
    collectionView.delegate = self
    collectionView.allowsMultipleSelection = true
    collectionView.register(PhotoCell.self, forCellWithReuseIdentifier: PhotoCell.reuseIdentifier)
    selectionPanGesture.delegate = self
    selectionPanGesture.maximumNumberOfTouches = 1
    collectionView.addGestureRecognizer(selectionPanGesture)
    collectionView.panGestureRecognizer.require(toFail: selectionPanGesture)
    collectionView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(collectionView)
    NSLayoutConstraint.activate([
      collectionView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
  }

  deinit {
    autoScrollDisplayLink?.invalidate()
  }

  func gestureRecognizerShouldBegin(_ gestureRecognizer: UIGestureRecognizer) -> Bool {
    guard gestureRecognizer === selectionPanGesture else { return true }
    let velocity = selectionPanGesture.velocity(in: collectionView)
    return abs(velocity.x) > abs(velocity.y)
  }

  @objc private func handleSelectionPan(_ gesture: UIPanGestureRecognizer) {
    latestDragLocation = gesture.location(in: collectionView)

    switch gesture.state {
    case .began:
      guard let indexPath = collectionView.indexPathForItem(at: latestDragLocation) else {
        return
      }
      let identifier = assets.object(at: indexPath.item).localIdentifier
      dragShouldSelect = !selectedIds.contains(identifier)
      dragVisitedIds.removeAll(keepingCapacity: true)
      applyDragSelection(at: indexPath)
      startAutoScroll()
    case .changed:
      applyDragSelectionAtLatestLocation()
    case .ended, .cancelled, .failed:
      stopAutoScroll()
      dragVisitedIds.removeAll(keepingCapacity: true)
    default:
      break
    }
  }

  private func applyDragSelectionAtLatestLocation() {
    guard let indexPath = collectionView.indexPathForItem(at: latestDragLocation) else { return }
    applyDragSelection(at: indexPath)
  }

  private func applyDragSelection(at indexPath: IndexPath) {
    let identifier = assets.object(at: indexPath.item).localIdentifier
    guard dragVisitedIds.insert(identifier).inserted else { return }

    if dragShouldSelect {
      guard selectedIds.count < limit else { return }
      guard !selectedIds.contains(identifier) else { return }
      selectedIds.append(identifier)
      collectionView.selectItem(at: indexPath, animated: false, scrollPosition: [])
    } else {
      selectedIds.removeAll { $0 == identifier }
      collectionView.deselectItem(at: indexPath, animated: false)
    }
    refreshSelectionNumbers()
  }

  private func startAutoScroll() {
    stopAutoScroll()
    let displayLink = CADisplayLink(target: self, selector: #selector(handleAutoScroll))
    displayLink.add(to: .main, forMode: .common)
    autoScrollDisplayLink = displayLink
  }

  private func stopAutoScroll() {
    autoScrollDisplayLink?.invalidate()
    autoScrollDisplayLink = nil
  }

  @objc private func handleAutoScroll() {
    let edgeHeight: CGFloat = 64
    let visibleTop = collectionView.contentOffset.y
    let visibleBottom = visibleTop + collectionView.bounds.height
    let locationY = latestDragLocation.y
    var deltaY: CGFloat = 0

    if locationY < visibleTop + edgeHeight {
      deltaY = -12 * (1 - max(locationY - visibleTop, 0) / edgeHeight)
    } else if locationY > visibleBottom - edgeHeight {
      deltaY = 12 * (1 - max(visibleBottom - locationY, 0) / edgeHeight)
    }

    guard deltaY != 0 else { return }
    let minimumOffset = -collectionView.adjustedContentInset.top
    let maximumOffset = max(
      minimumOffset,
      collectionView.contentSize.height - collectionView.bounds.height
        + collectionView.adjustedContentInset.bottom
    )
    let nextOffset = min(max(collectionView.contentOffset.y + deltaY, minimumOffset), maximumOffset)
    guard nextOffset != collectionView.contentOffset.y else { return }
    collectionView.contentOffset.y = nextOffset
    latestDragLocation.y += nextOffset - visibleTop
    applyDragSelectionAtLatestLocation()
  }

  func collectionView(_ collectionView: UICollectionView, numberOfItemsInSection section: Int) -> Int {
    assets.count
  }

  func collectionView(
    _ collectionView: UICollectionView,
    cellForItemAt indexPath: IndexPath
  ) -> UICollectionViewCell {
    let cell = collectionView.dequeueReusableCell(
      withReuseIdentifier: PhotoCell.reuseIdentifier,
      for: indexPath
    ) as! PhotoCell
    let asset = assets.object(at: indexPath.item)
    let scale = UIScreen.main.scale
    let side = floor((collectionView.bounds.width - 6) / 4) * scale
    cell.representedAssetIdentifier = asset.localIdentifier
    cell.setSelectionNumber(selectedIds.firstIndex(of: asset.localIdentifier).map { $0 + 1 })
    imageManager.requestImage(
      for: asset,
      targetSize: CGSize(width: side, height: side),
      contentMode: .aspectFill,
      options: nil
    ) { image, _ in
      guard cell.representedAssetIdentifier == asset.localIdentifier else { return }
      cell.imageView.image = image
    }
    return cell
  }

  func collectionView(
    _ collectionView: UICollectionView,
    layout collectionViewLayout: UICollectionViewLayout,
    sizeForItemAt indexPath: IndexPath
  ) -> CGSize {
    let side = floor((collectionView.bounds.width - 6) / 4)
    return CGSize(width: side, height: side)
  }

  func collectionView(_ collectionView: UICollectionView, didSelectItemAt indexPath: IndexPath) {
    let identifier = assets.object(at: indexPath.item).localIdentifier
    guard selectedIds.count < limit else {
      collectionView.deselectItem(at: indexPath, animated: false)
      return
    }
    selectedIds.append(identifier)
    refreshSelectionNumbers()
  }

  func collectionView(_ collectionView: UICollectionView, didDeselectItemAt indexPath: IndexPath) {
    let identifier = assets.object(at: indexPath.item).localIdentifier
    selectedIds.removeAll { $0 == identifier }
    refreshSelectionNumbers()
  }

  private func refreshSelectionNumbers() {
    doneButton.title = "完了 (\(selectedIds.count))"
    doneButton.isEnabled = !selectedIds.isEmpty
    collectionView.indexPathsForVisibleItems.forEach { indexPath in
      guard let cell = collectionView.cellForItem(at: indexPath) as? PhotoCell else { return }
      let identifier = assets.object(at: indexPath.item).localIdentifier
      cell.setSelectionNumber(selectedIds.firstIndex(of: identifier).map { $0 + 1 })
    }
  }

  @objc private func cancelTapped() {
    onCancel?()
  }

  @objc private func doneTapped() {
    onComplete?(selectedIds, Date())
  }
}

private final class PhotoCell: UICollectionViewCell {
  static let reuseIdentifier = "PhotoCell"
  let imageView = UIImageView()
  private let badge = UILabel()
  var representedAssetIdentifier: String?

  override init(frame: CGRect) {
    super.init(frame: frame)
    imageView.contentMode = .scaleAspectFill
    imageView.clipsToBounds = true
    imageView.translatesAutoresizingMaskIntoConstraints = false
    badge.backgroundColor = UIColor.systemBlue
    badge.textColor = .white
    badge.font = .boldSystemFont(ofSize: 13)
    badge.textAlignment = .center
    badge.layer.cornerRadius = 12
    badge.clipsToBounds = true
    badge.translatesAutoresizingMaskIntoConstraints = false
    contentView.addSubview(imageView)
    contentView.addSubview(badge)
    NSLayoutConstraint.activate([
      imageView.topAnchor.constraint(equalTo: contentView.topAnchor),
      imageView.leadingAnchor.constraint(equalTo: contentView.leadingAnchor),
      imageView.trailingAnchor.constraint(equalTo: contentView.trailingAnchor),
      imageView.bottomAnchor.constraint(equalTo: contentView.bottomAnchor),
      badge.topAnchor.constraint(equalTo: contentView.topAnchor, constant: 5),
      badge.trailingAnchor.constraint(equalTo: contentView.trailingAnchor, constant: -5),
      badge.widthAnchor.constraint(equalToConstant: 24),
      badge.heightAnchor.constraint(equalToConstant: 24),
    ])
  }

  required init?(coder: NSCoder) {
    fatalError("init(coder:) has not been implemented")
  }

  override func prepareForReuse() {
    super.prepareForReuse()
    imageView.image = nil
    representedAssetIdentifier = nil
    setSelectionNumber(nil)
  }

  func setSelectionNumber(_ number: Int?) {
    badge.isHidden = number == nil
    badge.text = number.map(String.init)
  }
}
