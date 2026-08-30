# Mobile staging environment

iPhone実機のアップロード検証専用AWS環境です。本番リソースとは名前とS3バケットを分離します。

## Resources

- S3: `tocoro-mobile-staging-881224647732-ap-northeast-1`
- ECR: `tocoro-mobile-staging`
- Lambda: `tocoro-mobile-staging`
- IAM role: `TocoroMobileStagingLambdaRole`
- Secrets: `tocoro-mobile-staging/app-password`, `tocoro-mobile-staging/auth-secret`

デプロイユーザーには [`mobile-staging-deployer-policy.json`](mobile-staging-deployer-policy.json) だけを付与します。

## Local configuration

```bash
aws configure --profile tocoro-mobile-staging
bash scripts/configure-mobile-staging-env.sh
```

`.env.mobile-staging`はGit管理外で、所有者だけが読み書きできるモード600で作成されます。

## Deploy

```bash
npm run deploy:mobile-staging
```

スクリプトはAWSアカウント、リージョン、検証用バケット名を照合し、不一致なら停止します。
アプリ終了などで即時削除できなかったテストデータも、S3ライフサイクルで1日後に削除されます。

## Integration test

```bash
DOTENV_CONFIG_PATH=.env.mobile-staging node -r dotenv/config \
  scripts/test-lambda.js <staging-lambda-url> --upload-test
```

テストは4バイトのJPEGデータを1件アップロードし、直後に削除します。実写真は使用しません。
