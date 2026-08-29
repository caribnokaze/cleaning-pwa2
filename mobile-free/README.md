# 無料iPhone写真選択テスト

Apple Developer Programを使わず、iPhone版Expo Goで動かすSDK 54試作です。
Expo Goに含まれる`expo-media-library`を利用し、写真IDと軽量サムネイルだけを選択します。

## iPhoneで試す

1. App Storeから無料の「Expo Go」をiPhoneへインストールする
2. WindowsとiPhoneを同じWi-Fiへ接続する
3. PowerShellで次を実行する

```powershell
cd C:\GitHub\cleaning-pwa3\mobile-free
nvm use 22.23.2
npx.cmd expo start
```

4. ターミナルに出るQRコードをiPhone標準カメラで読み取る
5. Expo Goでプロジェクトを開く
6. 写真アクセスは「すべての写真を許可」を選ぶ
7. 5枚と100枚で、完了後に表示される画面復帰時間を比較する

同じWi-Fiで接続できない場合は次を使用します。

```powershell
npx.cmd expo start --tunnel
```

## 制約

これは操作感を無料で検証する試作です。独自Swift版そのものではありません。
改善効果を確認できた場合、Apple Developer Program登録後に`mobile`プロジェクトのPhotoKit実装へ進みます。
