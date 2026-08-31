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

`Dockerfile`はAWS Lambda Web Adapterを使用します。正式デプロイ前に、検証専用IAM
ロール、Secrets Manager、Function URL、S3ライフサイクルを別PRで構成します。
