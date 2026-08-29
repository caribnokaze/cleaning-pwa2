import ExpoModulesCore
import Photos
import UIKit

public final class FastPhotoPickerModule: Module {
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

private final class PhotoGridViewController: UIViewController,
  UICollectionViewDataSource,
  UICollectionViewDelegateFlowLayout {
  var onCancel: (() -> Void)?
  var onComplete: (([String], Date) -> Void)?

  private let limit: Int
  private let imageManager = PHCachingImageManager()
  private var assets: PHFetchResult<PHAsset>!
  private var selectedIds: [String] = []
  private var collectionView: UICollectionView!
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
    collectionView.translatesAutoresizingMaskIntoConstraints = false
    view.addSubview(collectionView)
    NSLayoutConstraint.activate([
      collectionView.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
      collectionView.leadingAnchor.constraint(equalTo: view.leadingAnchor),
      collectionView.trailingAnchor.constraint(equalTo: view.trailingAnchor),
      collectionView.bottomAnchor.constraint(equalTo: view.bottomAnchor),
    ])
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
