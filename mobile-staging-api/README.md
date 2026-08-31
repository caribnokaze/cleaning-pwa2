# TOCORO mobile staging API

iOS・Androidネイティブ写真機能の実機試験だけに使う独立APIです。
本番Webサーバーや本番S3には接続しません。

## 提供するAPI

- `GET /health`
- `POST /api/mobile/login`
- `POST /api/mobile-test/presigned-urls`
- `GET /api/mobile-test/runs/:runId`
- `DELETE /api/mobile-test/runs/:runId`

## 安全条件

- リージョンは`ap-northeast-1`のみ
- S3は`tocoro-mobile-staging-[12桁のAWSアカウントID]-ap-northeast-1`のみ
- 写真は`_system/mobile-test/`配下のみ
- 署名付きURLは15分で失効
- APIトークンは1時間で失効
- パスワード、トークン、署名付きURLをログへ出さない
- S3には`_system/mobile-test/`を1日後に削除するライフサイクルを別途設定する

## ローカル起動

```bash
cp .env.example .env
npm ci
set -a
source .env
set +a
npm start
```

`.env`には実際の秘密値を設定し、Gitへコミットしません。AWS上ではアクセスキーを
環境変数へ入れず、Lambda実行ロールを使用します。

## コンテナ

`Dockerfile`はAWS Lambda Web Adapterを使用します。Lambdaでは秘密値を環境変数へ
直接保存せず、起動時にSecrets Managerから取得します。

## AWSリソース

既存の検証APIを上書きしないよう、次の新しい名前を使用します。

- ECR: `tocoro-mobile-staging-api`
- Lambda: `tocoro-mobile-staging-api`
- IAM role: `TocoroMobileStagingApiLambdaRole`
- Secrets: `tocoro-mobile-staging-api/app-password`、`tocoro-mobile-staging-api/auth-secret`
- S3: 既存の`tocoro-mobile-staging-[account]-ap-northeast-1`を利用

Lambda実行ロールが操作できるS3オブジェクトは`_system/mobile-test/`配下だけです。
ライフサイクル設定は既存ルールを残し、テスト写真を1日後に削除するルールだけを
追加または更新します。

## デプロイ準備

1. デプロイ用IAMユーザーへ[`aws/deployer-policy.json`](aws/deployer-policy.json)を設定します。
2. AWS CLIの`tocoro-mobile-staging`プロファイルが正しいことを確認します。
3. Docker Desktopを起動します。
4. 次を実行してローカル秘密ファイルを作ります。

```bash
bash scripts/configure-env.sh
```

`.env.mobile-staging`は権限600で作成され、GitとDockerイメージから除外されます。

## デプロイ

コードレビューとDraft PRの確認が終わるまで実行しません。承認後に次を実行します。

```bash
npm ci
npm run deploy
```

スクリプトは最初にAWSアカウント、東京リージョン、検証用バケット名を照合します。
一致しない場合はAWSリソースを変更せず停止します。成功時に新しいLambda Function URLが
表示されます。そのURLをモバイルビルドの`EXPO_PUBLIC_MOBILE_STAGING_API_URL`へ設定します。
