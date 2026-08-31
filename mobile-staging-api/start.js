const {
  GetSecretValueCommand,
  SecretsManagerClient,
} = require("@aws-sdk/client-secrets-manager");

async function loadSecret(environmentName, secretIdName) {
  if (process.env[environmentName]) return;
  const secretId = process.env[secretIdName];
  if (!secretId) return;
  const client = new SecretsManagerClient({ region: process.env.AWS_REGION });
  const result = await client.send(new GetSecretValueCommand({ SecretId: secretId }));
  if (!result.SecretString) throw new Error(`${secretIdName} is empty`);
  process.env[environmentName] = result.SecretString;
}

async function main() {
  await Promise.all([
    loadSecret("APP_PASSWORD", "APP_PASSWORD_SECRET_ID"),
    loadSecret("AUTH_SECRET", "AUTH_SECRET_ID"),
  ]);
  const { createApp } = require("./server");
  const port = Number(process.env.PORT || 8080);
  createApp().listen(port, () => console.log(`Mobile staging API listening on ${port}`));
}

main().catch((error) => {
  console.error("Mobile staging API startup failed", error?.name || "UnknownError");
  process.exitCode = 1;
});
