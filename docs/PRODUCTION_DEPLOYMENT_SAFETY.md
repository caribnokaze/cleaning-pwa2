# 本番デプロイ安全手順

本番デプロイは、事前確認と明示承認を分離します。以下のコマンドは
AWSアカウント `881224647732`、東京リージョン、指定済み本番S3バケット以外では
処理を停止します。

## 1. 事前確認（AWSを変更しない）

実際に使用中の配信方式に対応する片方だけを実行します。

```bash
npm run preflight:lambda
```

または:

```bash
npm run preflight:aws
```

この処理はSTS、S3、ECR、IAM、Secrets Managerと、LambdaまたはApp Runnerを
読み取るだけです。Docker build、push、秘密値更新、サービス更新は行いません。

## 2. 本番デプロイ

事前確認、変更内容のレビュー、バックアップ・復旧手順、明示的な実行承認が
すべて揃った場合だけ実行します。

Lambda:

```bash
DEPLOY_TARGET=production PRODUCTION_DEPLOY_APPROVED=true npm run deploy:lambda
```

App Runner:

```bash
DEPLOY_TARGET=production PRODUCTION_DEPLOY_APPROVED=true npm run deploy:aws
```

`DEPLOY_TARGET=production` または `PRODUCTION_DEPLOY_APPROVED=true` がない場合、
AWSリソースを更新する前に停止します。LambdaとApp Runnerを同時にデプロイしては
いけません。現在 `tocoro-report.com` が接続している配信方式を確認して選択します。
これら2つの安全確認値は `.env` に保存せず、実行するコマンドにだけ指定します。

本番デプロイでは、Secrets Managerに保存済みの共有パスワードと認証秘密値のARNだけを
参照します。秘密値の取得、作成、更新は行わないため、既存Web利用者の認証状態を
デプロイによって変更しません。検証環境だけは分離済みの検証用秘密値を更新できます。
