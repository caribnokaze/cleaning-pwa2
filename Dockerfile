FROM node:18-slim

# アプリケーションディレクトリを作成
WORKDIR /usr/src/app

# パッケージ定義をコピーしてインストール
COPY package*.json ./
RUN npm install

# 全ファイルをコピー
COPY . .

# ポート8080を公開
EXPOSE 8080

# アプリを起動
CMD [ "npm", "start" ]
