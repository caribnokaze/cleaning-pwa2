# 社内向けアプリ配布

対象はiPhone 50台、Android 30台を想定する。

## 配布方式

- iOS: App Store Connectへ提出し、Apple BusinessのカスタムAppとして会社だけに公開する。
- iOSの導入: Apple Businessで取得した引き換えコードを利用者へ個別配布する。
- iOSの更新: 通常のApp Storeアプリと同様にApp Store経由で配信する。
- Android: 当面は署名済みAPKをアクセス制御された社内連絡手段で配布する。

## 重要事項

現在のアプリは検証用APIの `/api/mobile-test/*` と、1日後に削除される
`_system/mobile-test/` を使用する。業務データを保存する用途では、本番APIへの切り替えが完了するまで提出しない。

配布制限だけを認証として使用しない。アプリ内認証を有効にし、退職・紛失時にサーバー側でアクセスを停止できる状態にする。

## Apple側の準備

1. 会社をApple Businessへ登録する。
2. Apple Businessで組織IDを確認する。
3. App Store Connectで新しいアプリを作成する。
4. 配信方法にPrivate Distribution（カスタムApp）を選ぶ。
5. 配信先として会社のApple Business組織IDを指定する。

Private Distributionは承認後にPublic Distributionへ変更できない。公開方法を確定してから保存する。

## iOSビルドと提出

`mobile`ディレクトリで実行する。

```powershell
npm.cmd install
npm.cmd run build:company:ios
npm.cmd run submit:company:ios
```

初回実行時は、Apple DeveloperおよびApp Store Connectの認証と署名情報の設定が必要になる。提出後、App Store Connectで説明、スクリーンショット、プライバシー情報、審査用アカウントを入力して審査へ提出する。

## iPhone利用者への配布

審査承認後、Apple Businessの「アプリとブック」でカスタムAppを取得する。アプリを無料に設定した場合も、Apple Business側で必要数のライセンスを取得する。

MDMを使わない運用では、引き換えコードを利用者ごとに1つずつ渡す。コードは使用後に別の利用者へ再割り当てできないため、利用者、コード、配布日を社内台帳へ記録する。

利用者はApple Accountでコードを引き換えてインストールする。以後の更新はApp Store経由で行われ、自動アップデートが有効な端末では自動更新される。

## Androidビルドと配布

```powershell
cd mobile
npm.cmd run build:company:android
```

完成したAPKのURLは対象者だけに共有する。AndroidにはiOS Ad HocのようなUDID制限がないため、APKの共有範囲とアプリ内認証の両方でアクセスを制限する。
