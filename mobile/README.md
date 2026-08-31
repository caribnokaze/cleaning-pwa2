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

## 現場情報付きステージング試験

1. 撮影日、現場名、担当者名を入力する
2. 独自高速ピッカーで写真を選択する
3. 検証環境のパスワードを入力して実送信する
4. アプリに表示される保存枚数、現場情報、容量を確認する
5. 「確認済みのテスト写真を削除」を押す

写真は本番とは分離した`_system/mobile-test/`へ保存されます。確認前にアプリを
終了した場合も、S3ライフサイクルにより1日後に自動削除されます。

準備処理は幅720px、JPEG品質45%、同時処理2枚です。iCloud取得と外部送信は行いません。

## 実機結果（100枚）

- 独自ピッカーの画面復帰: 約522ms
- 読み込み・圧縮: 1,802ms（成功100枚、失敗0枚）
- 容量: 263.1MBから7.0MB（約97.3%削減）
- ローカル送信の独立試験: 507ms（100件、4並列、7,333,312バイト）
- 検証専用S3への実送信: 準備2,166ms、送信1,619ms、合計3,785ms
- 検証専用S3の結果: 成功100枚、約7.0MB、計測後に100枚削除
- 現場情報付き実送信: 準備1,896ms、送信1,743ms、合計3,640ms
- 現場情報付き実送信の結果: 成功100枚、約7.7MB、撮影日・現場名・担当者を照合後に100枚削除

ローカル送信試験用のHTTP許可、Mac固定IP、受信サーバーは試験後に削除済みです。
実送信試験では本番と分離した検証専用LambdaとS3バケットを使用します。
