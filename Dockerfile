FROM nginx:alpine
# カレントディレクトリのファイルをnginxの公開ディレクトリにコピー
COPY . /usr/share/nginx/html
