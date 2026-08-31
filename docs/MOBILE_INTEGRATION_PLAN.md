# モバイル実運用統合計画

## 現在地

`feature/capacitor-app`では、iOS・Androidの独自3列写真ピッカー、100枚圧縮、
検証S3送信、再試行、中断復帰まで実機確認済みです。検証先は本番と分離した
Lambda・S3であり、本番データには接続していません。

現在のDraft PRはWeb、AWS、Capacitor、Expo Free、ネイティブExpoを含むため、
そのまま`main`へマージしません。

## PR分割

1. `mobile-native-core`
   - `mobile/`
   - iOS / Android独自写真ピッカー
   - 圧縮、再試行、中断復帰の共通インターフェース
   - 本番API URLは含めない
2. `mobile-staging-api`
   - `/api/mobile/*`と`/api/mobile-test/*`
   - 検証Lambda・S3設定
   - `_system/mobile-test/`の1日後自動削除
3. `web-and-auth`
   - Web PWA、認証、ギャラリーの変更
   - モバイル機能と独立してレビュー・テスト
4. `legacy-capacitor-wrapper`
   - 継続利用するか判断するまでマージしない
   - 現在は`tocoro-report.com`を直接表示する試作設定
5. `mobile-free`
   - 無料Expo版を製品として残すか判断するまでマージしない

## 共通アーキテクチャ

React Native側は次を共通管理します。

- 実行ID、撮影日、現場名、担当者名、写真参照ID
- 署名付きURLの取得
- S3保存済みファイルとの照合
- 失敗した写真だけの再送
- アプリ再起動後の中断復帰
- 検証写真の削除

ネイティブ側は同一インターフェースを実装します。

- `pickPhotos(limit)`
- `pickPhotosWithSystemPicker(limit)`
- `preparePhotos(assetIds, maxWidth, jpegQuality)`
- `prepareAndUploadPhotos(assetIds, uploadUrls, maxWidth, jpegQuality, simulationMode)`

iOSはPhotoKit ID、AndroidはMediaStore URIを写真参照IDとして使用します。
パスワード、認証トークン、署名付きURLは永続保存しません。

## 本番統合前の必須作業

- 検証URLのハードコードをビルド環境変数へ移す
- 検証用の通信失敗スイッチと削除UIをRelease製品画面から外す
- 共有パスワード方式を既存の本番認証フローへ統合する
- Android正式署名鍵とPlay App Signingを設定する
- iOS配布用Bundle ID・署名・権限文言を確定する
- アプリ名、アイコン、バージョン番号、プライバシー説明を確定する
- Androidのバックグラウンド制限を考慮し、必要ならWorkManagerへ移行する
- E2E試験でS3キー形式とWebギャラリー表示を確認する
- ログへパスワード、トークン、署名付きURLを出さないことを確認する

## 受入基準

- iOS / Androidとも100枚を選択できる
- タップ、横なぞり、下端自動スクロールが動作する
- 720px・JPEG 45%で100枚すべてを圧縮できる
- 送信失敗時は失敗分だけ再送できる
- アプリ終了・通信切断後に未送信分を再開できる
- 撮影日・現場名・担当者名・写真の向きが正しい
- アプリから保存結果を照合できる
- 本番投入前の試験データを完全に削除できる
- USB・Mac開発サーバーなしのRelease版で全操作が完了する

## 次の実装順

1. Draft PRを上記単位へ分割する
2. `mobile-native-core`をCIでビルドする
3. ステージングAPI URLを環境別設定へ移す
4. 本番認証・本番写真APIとの統合仕様を確定する
5. 新しい非本番環境でE2E試験する
6. レビュー後に各PRを個別にマージする

