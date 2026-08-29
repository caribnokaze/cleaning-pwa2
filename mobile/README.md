# TOCORO PhotoKit prototype

iPhoneで大量写真を選択した後の画面復帰速度を検証するExpo SDK 57試作です。
写真本体ではなくPhotoKitの`PHAsset.localIdentifier`だけを選択時に返します。

## 必要条件

- Windows: Node.js 20.19以上（現在はNVMのNode.js 22.23.2を使用）
- Expoアカウント
- Apple Developer Programアカウント
- テスト用iPhone（iOS 16.4以上）

Expo Goには独自PhotoKitモジュールが含まれないため、この試作はEAS development buildが必要です。

## 初回ビルド

```powershell
cd mobile
npx eas-cli@latest login
npx eas-cli@latest build:configure
npx eas-cli@latest build --platform ios --profile development
```

画面の案内に従い、Apple Developerアカウント、Bundle ID、実機登録、署名情報を設定します。
ビルド完了後に表示されるURLをiPhoneで開き、development buildをインストールします。

## 起動

```powershell
cd mobile
npm start
```

iPhoneのdevelopment buildから表示されたQRコード／開発サーバーへ接続します。

## 測定

1. 「写真を選択」を押す
2. 5枚選び「完了」を押す
3. 表示された画面復帰時間を記録する
4. 100枚でも同じ操作を行う
5. 現在のWeb版と比較する

この段階では写真本体の読み込みやS3アップロードを行いません。速度改善を確認後、画面復帰後の非同期読み込み、進捗表示、既存Lambda/S3連携を追加します。
