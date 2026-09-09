FROM public.ecr.aws/docker/library/node:22-slim

COPY --from=public.ecr.aws/awsguru/aws-lambda-adapter:1.0.0 \
  /lambda-adapter /opt/extensions/lambda-adapter

ENV PORT=8080
ENV AWS_LWA_INVOKE_MODE=response_stream
ENV AWS_LWA_READINESS_CHECK_PATH=/health

WORKDIR /var/task
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js ./

EXPOSE 8080
CMD ["node", "server.js"]
