#!/bin/bash
set -euo pipefail

cd "$(dirname "$0")/.."

printf "検証環境のログインパスワード（8文字以上）: "
IFS= read -r -s app_password
printf "\n"
if [ "${#app_password}" -lt 8 ]; then
  echo "パスワードは8文字以上にしてください。" >&2
  exit 1
fi

auth_secret="$(openssl rand -hex 32)"
umask 077
{
  printf '%s\n' 'AWS_REGION=ap-northeast-1'
  printf '%s\n' 'S3_BUCKET=tocoro-mobile-staging-881224647732-ap-northeast-1'
  printf 'APP_PASSWORD=%s\n' "$app_password"
  printf 'AUTH_SECRET=%s\n' "$auth_secret"
} > .env.mobile-staging

unset app_password auth_secret
echo ".env.mobile-staging を安全な権限で作成しました。"
