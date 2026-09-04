#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."
profile="tocoro-mobile-staging"
account_id="$(aws sts get-caller-identity --profile "$profile" --query Account --output text)"
if ! [[ "$account_id" =~ ^[0-9]{12}$ ]]; then
  echo "AWSアカウントIDを確認できませんでした。" >&2
  exit 1
fi

printf "検証環境のログインパスワード（8文字以上）: "
IFS= read -r -s app_password
printf "\n"
if [ "${#app_password}" -lt 8 ]; then
  echo "パスワードは8文字以上にしてください。" >&2
  exit 1
fi
printf "同じパスワードをもう一度入力: "
IFS= read -r -s confirmation
printf "\n"
if [ "$app_password" != "$confirmation" ]; then
  unset app_password confirmation
  echo "2回のパスワードが一致しません。" >&2
  exit 1
fi
unset confirmation

auth_secret="$(openssl rand -hex 32)"
umask 077
{
  printf '%s\n' "AWS_PROFILE=$profile"
  printf '%s\n' 'AWS_REGION=ap-northeast-1'
  printf '%s\n' "S3_BUCKET=tocoro-mobile-staging-$account_id-ap-northeast-1"
  printf 'APP_PASSWORD=%s\n' "$app_password"
  printf 'AUTH_SECRET=%s\n' "$auth_secret"
} > .env.mobile-staging
unset app_password auth_secret
chmod 600 .env.mobile-staging
echo ".env.mobile-staging を権限600で作成しました。"
