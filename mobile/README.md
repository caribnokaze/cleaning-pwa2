# TOCORO PhotoKit prototype

iPhoneで大量写真を選択した後の画面復帰速度を検証するExpo SDK 57試作です。
写真本体ではなくPhotoKitの`PHAsset.localIdentifier`だけを選択時に返します。

## 必要条件

- macOS + Xcode
- Node.js 20.19以上
- CocoaPods
- Expoアカウント
- Apple Developer Programアカウント
- テスト用iPhone（iOS 16.4以上）

Expo Goには独自PhotoKitモジュールが含まれないため、実機用のネイティブビルドが必要です。

## 初回ビルド

```bash
cd mobile
npm install
npx expo prebuild --platform ios --no-install
cd ios
pod install
```

`ios/TOCOROPhotoPrototype.xcworkspace`をXcodeで開き、接続したiPhoneを実行先にします。
Bundle IDは`com.tocoro.cleaning.photo-prototype`です。

## 起動

```bash
cd mobile
npm run ios
```

ReleaseビルドではJavaScript bundleをアプリへ含められるため、実機計測時に本番サイトへ接続する必要はありません。

## 測定

1. 「独自高速ピッカー」を押す
2. 横方向になぞって最大100枚を選択する（縦方向はスクロール）
3. 「完了」を押し、画面復帰時間を記録する
4. 「選択写真を準備して計測」を押す
5. 読み込み・圧縮時間、成功枚数、変換前後の容量を記録する

準備処理は幅720px、JPEG品質45%、同時処理2枚です。iCloud取得と外部送信は行いません。

## 実機結果（100枚）

- 独自ピッカーの画面復帰: 約522ms
- 読み込み・圧縮: 1,802ms（成功100枚、失敗0枚）
- 容量: 263.1MBから7.0MB（約97.3%削減）
- ローカル送信の独立試験: 507ms（100件、4並列、7,333,312バイト）

ローカル送信試験用のHTTP許可、Mac固定IP、受信サーバーは試験後に削除済みです。
次段階では本番と分離した検証専用APIとS3バケットを使用します。
