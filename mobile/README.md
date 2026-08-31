# TOCORO native photo picker prototype

iPhone・Androidで大量写真を選択した後の画面復帰速度を検証するExpo SDK 57試作です。
選択時は写真本体ではなく、iOSではPhotoKitのID、AndroidではMediaStoreのURIだけを返します。

## 必要条件

- macOS + Xcode
- Node.js 20.19以上
- CocoaPods
- Expoアカウント
- Apple Developer Programアカウント
- テスト用iPhone（iOS 16.4以上）
- Android Studio + JDK 21 + Android SDK
- テスト用Android端末（Android 7.0以上）

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

Androidは次の手順でネイティブプロジェクトを生成し、Android StudioまたはGradleから
実機へインストールします。

```bash
cd mobile
npx expo prebuild --platform android --no-install
npm run android
```

Android application IDは`com.tocoro.cleaning.photo_prototype`です。

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

検証API URLはリポジトリへ固定せず、Git管理外の`mobile/.env.local`に設定します。

```bash
cp .env.example .env.local
```

```env
EXPO_PUBLIC_MOBILE_STAGING_API_URL=https://your-staging-api.example
```

1. 撮影日、現場名、担当者名を入力する
2. 独自高速ピッカーで写真を選択する
3. 検証環境のパスワードを入力して実送信する
4. アプリに表示される保存枚数、現場情報、容量を確認する
5. 「確認済みのテスト写真を削除」を押す

写真は本番とは分離した`_system/mobile-test/`へ保存されます。確認前にアプリを
終了した場合も、S3ライフサイクルにより1日後に自動削除されます。

## 中断復帰

送信開始前に、実行ID・写真ID・撮影日・現場名・担当者名を端末へ保存します。
アプリ終了や通信切断の後はS3の保存済みファイル名を照合し、未送信写真だけを
再準備・再送します。この制御はReact Native側にあり、iOSとAndroidで共通利用します。

パスワード、認証トークン、署名付きURLは端末へ保存しません。復帰時には検証環境の
パスワードを再入力します。ジョブ情報は検証写真の削除成功後に端末から削除されます。

実機では100枚中90枚を保存した状態でアプリを完全終了し、再起動後に未送信10枚だけを
再開しました。最終的に100枚の保存を照合し、検証S3から100枚を削除済みです。

準備処理は幅720px、JPEG品質45%です。iOSは同時処理2枚、Androidは4枚です。
iOSではiCloud取得を行わず、AndroidではMediaStoreから端末内写真を読み込みます。
独自ピッカーは写真を判別しやすい3列表示です。横になぞり始めてから
指を画面下端へ移動すると、スクロールしながら通過範囲を連続選択できます。

## 実機結果（100枚）

- 独自ピッカーの画面復帰: 約522ms
- 読み込み・圧縮: 1,802ms（成功100枚、失敗0枚）
- 容量: 263.1MBから7.0MB（約97.3%削減）
- ローカル送信の独立試験: 507ms（100件、4並列、7,333,312バイト）
- 検証専用S3への実送信: 準備2,166ms、送信1,619ms、合計3,785ms
- 検証専用S3の結果: 成功100枚、約7.0MB、計測後に100枚削除
- 現場情報付き実送信: 準備1,896ms、送信1,743ms、合計3,640ms
- 現場情報付き実送信の結果: 成功100枚、約7.7MB、撮影日・現場名・担当者を照合後に100枚削除
- 再送試験: 10枚を意図的に失敗（90枚成功・自動再試行30回）させ、失敗した10枚だけを手動再送
- 再送試験の結果: 100枚の保存を照合し、検証S3から100枚削除

### Android実機（OPPO A002OP / Android 11）

- 独自ピッカーの画面復帰: 約35ms（100枚）
- 最適化前の読み込み・圧縮: 12,687ms
- 最適化後の読み込み・圧縮: 4,101ms（約68%短縮、成功100枚）
- 容量: 304.9MBから4.3MB（約98.6%削減）
- 検証専用S3への実送信: 準備4,019ms、送信1,913ms、合計5,932ms
- 検証専用S3の結果: 成功100枚、約4.3MB、計測後に100枚削除
- 再送試験: 成功100枚、自動再試行30回、手動再送1回、確認後に100枚削除
- 中断復帰試験: アプリ終了後に未完了ジョブを検出し、再開後100枚の保存に成功
- Release APK単独試験: USB・Mac開発サーバーなしで起動、写真選択、検証S3送信に成功
- Release APK中断復帰: 送信中に終了し、アイコンから再起動後に100枚の送信を完了・削除

ローカル送信試験用のHTTP許可、Mac固定IP、受信サーバーは試験後に削除済みです。
実送信試験では本番と分離した検証専用LambdaとS3バケットを使用します。
