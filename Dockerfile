FROM nginx:alpine

# Cloud Runのポート設定に合わせるための設定変更
RUN sed -i 's/listen       80;/listen       8080;/g' /etc/nginx/conf.d/default.conf

# ファイルをコピー
COPY . /usr/share/nginx/html

# ポート8080を公開
EXPOSE 8080
