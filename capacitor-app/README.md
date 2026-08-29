# TOCORO.清掃 Capacitor app

既存の本番Webを変更せず、Android WebViewで動作確認するための分離プロジェクトです。

## 初期検証

現在は `https://tocoro-report.com` を読み込む設定です。これは端末での互換性確認用であり、ストア提出版ではWeb資産をアプリへ同梱し、APIだけ本番サーバーへ接続する構成へ移行します。

## コマンド

```powershell
cd C:\GitHub\cleaning-pwa3-capacitor\capacitor-app
npm.cmd install
npm.cmd run android:add
npm.cmd run android:open
```

AndroidのビルドにはAndroid Studio、Android SDK、JDKが必要です。
