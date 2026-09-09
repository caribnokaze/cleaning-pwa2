require("dotenv").config();
const { spawnSync } = require("child_process");
const {
  STSClient,
  GetCallerIdentityCommand,
} = require("@aws-sdk/client-sts");
const {
  ECRClient,
  CreateRepositoryCommand,
  DescribeRepositoriesCommand,
  GetAuthorizationTokenCommand,
} = require("@aws-sdk/client-ecr");
const {
  IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  AttachRolePolicyCommand,
  PutRolePolicyCommand,
} = require("@aws-sdk/client-iam");
const {
  SecretsManagerClient,
  CreateSecretCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  AppRunnerClient,
  CreateServiceCommand,
  UpdateServiceCommand,
  ListServicesCommand,
  DescribeServiceCommand,
} = require("@aws-sdk/client-apprunner");
const {
  S3Client,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const BUCKET = process.env.S3_BUCKET ||
  "tocoro-cleaning-report-881224647732-ap-northeast-1-an";
const SERVICE_NAME = "tocoro-cleaning-report";
const REPOSITORY_NAME = "tocoro-cleaning-report";
const ECR_ROLE_NAME = "TocoroCleaningAppRunnerEcrRole";
const INSTANCE_ROLE_NAME = "TocoroCleaningAppRunnerInstanceRole";
const APP_PASSWORD_SECRET = "tocoro-cleaning/app-password";
const AUTH_SECRET_NAME = "tocoro-cleaning/auth-secret";

if (!process.env.APP_PASSWORD || !process.env.AUTH_SECRET) {
  throw new Error(".envにAPP_PASSWORDとAUTH_SECRETを設定してください。");
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const clients = {
  sts: new STSClient({ region: REGION }),
  ecr: new ECRClient({ region: REGION }),
  iam: new IAMClient({ region: REGION }),
  secrets: new SecretsManagerClient({ region: REGION }),
  appRunner: new AppRunnerClient({ region: REGION }),
  s3: new S3Client({ region: REGION }),
};

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: [options.input ? "pipe" : "inherit", "inherit", "inherit"],
    input: options.input,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command}が終了コード${result.status}で失敗しました。`);
}

async function getOrCreateRepository() {
  try {
    const result = await clients.ecr.send(new DescribeRepositoriesCommand({
      repositoryNames: [REPOSITORY_NAME],
    }));
    return result.repositories[0];
  } catch (error) {
    if (error.name !== "RepositoryNotFoundException") throw error;
    const result = await clients.ecr.send(new CreateRepositoryCommand({
      repositoryName: REPOSITORY_NAME,
      imageScanningConfiguration: { scanOnPush: true },
      imageTagMutability: "MUTABLE",
    }));
    return result.repository;
  }
}

async function getOrCreateRole(name, servicePrincipal) {
  try {
    const result = await clients.iam.send(new GetRoleCommand({ RoleName: name }));
    return result.Role;
  } catch (error) {
    if (error.name !== "NoSuchEntityException") throw error;
    const result = await clients.iam.send(new CreateRoleCommand({
      RoleName: name,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: servicePrincipal },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    return result.Role;
  }
}

async function putSecret(name, value) {
  try {
    const result = await clients.secrets.send(new DescribeSecretCommand({ SecretId: name }));
    await clients.secrets.send(new PutSecretValueCommand({ SecretId: name, SecretString: value }));
    return result.ARN;
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    const result = await clients.secrets.send(new CreateSecretCommand({
      Name: name,
      SecretString: value,
    }));
    return result.ARN;
  }
}

async function waitForService(serviceArn) {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await clients.appRunner.send(new DescribeServiceCommand({ ServiceArn: serviceArn }));
    const { Status, ServiceUrl } = result.Service;
    process.stdout.write(`\rApp Runner: ${Status}   `);
    if (Status === "RUNNING") {
      process.stdout.write("\n");
      return { serviceUrl: ServiceUrl, service: result.Service };
    }
    if (["CREATE_FAILED", "UPDATE_FAILED", "DELETE_FAILED"].includes(Status)) {
      throw new Error(`App Runnerの処理に失敗しました: ${Status}`);
    }
    await sleep(10000);
  }
  throw new Error("App Runnerの起動待ちがタイムアウトしました。");
}

async function updateBucketCors(origin) {
  let rules = [];
  try {
    const result = await clients.s3.send(new GetBucketCorsCommand({ Bucket: BUCKET }));
    rules = result.CORSRules || [];
  } catch (error) {
    if (error.name !== "NoSuchCORSConfiguration") throw error;
  }

  rules = rules.filter(rule => !rule.ID || rule.ID !== "tocoro-app-runner");
  rules.push({
    ID: "tocoro-app-runner",
    AllowedOrigins: [origin],
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  });
  await clients.s3.send(new PutBucketCorsCommand({
    Bucket: BUCKET,
    CORSConfiguration: { CORSRules: rules },
  }));
}

async function main() {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  console.log(`AWS account: ${identity.Account} / region: ${REGION}`);

  const repository = await getOrCreateRepository();
  const auth = await clients.ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = auth.authorizationData[0];
  const [, password] = Buffer.from(authData.authorizationToken, "base64")
    .toString("utf8")
    .split(":");
  run("docker", ["login", "--username", "AWS", "--password-stdin", authData.proxyEndpoint], {
    input: `${password}\n`,
  });
  run("docker", ["build", "--pull", "-t", `${REPOSITORY_NAME}:latest`, "."]);
  run("docker", ["tag", `${REPOSITORY_NAME}:latest`, `${repository.repositoryUri}:latest`]);
  run("docker", ["push", `${repository.repositoryUri}:latest`]);

  const passwordSecretArn = await putSecret(APP_PASSWORD_SECRET, process.env.APP_PASSWORD);
  const authSecretArn = await putSecret(AUTH_SECRET_NAME, process.env.AUTH_SECRET);
  const ecrRole = await getOrCreateRole(ECR_ROLE_NAME, "build.apprunner.amazonaws.com");
  await clients.iam.send(new AttachRolePolicyCommand({
    RoleName: ECR_ROLE_NAME,
    PolicyArn: "arn:aws:iam::aws:policy/service-role/AWSAppRunnerServicePolicyForECRAccess",
  }));
  const instanceRole = await getOrCreateRole(INSTANCE_ROLE_NAME, "tasks.apprunner.amazonaws.com");
  await clients.iam.send(new PutRolePolicyCommand({
    RoleName: INSTANCE_ROLE_NAME,
    PolicyName: "TocoroCleaningS3AndSecrets",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListBucket", "s3:GetBucketCORS", "s3:PutBucketCORS"],
          Resource: `arn:aws:s3:::${BUCKET}`,
        },
        {
          Effect: "Allow",
          Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"],
          Resource: `arn:aws:s3:::${BUCKET}/*`,
        },
        {
          Effect: "Allow",
          Action: ["secretsmanager:GetSecretValue"],
          Resource: [passwordSecretArn, authSecretArn],
        },
      ],
    }),
  }));

  const sourceConfiguration = {
    AutoDeploymentsEnabled: false,
    AuthenticationConfiguration: { AccessRoleArn: ecrRole.Arn },
    ImageRepository: {
      ImageIdentifier: `${repository.repositoryUri}:latest`,
      ImageRepositoryType: "ECR",
      ImageConfiguration: {
        Port: "8080",
        RuntimeEnvironmentVariables: {
          NODE_ENV: "production",
          AWS_REGION: REGION,
          S3_BUCKET: BUCKET,
        },
        RuntimeEnvironmentSecrets: {
          APP_PASSWORD: passwordSecretArn,
          AUTH_SECRET: authSecretArn,
        },
      },
    },
  };

  const listed = await clients.appRunner.send(new ListServicesCommand({ MaxResults: 20 }));
  const existing = (listed.ServiceSummaryList || []).find(item => item.ServiceName === SERVICE_NAME);
  let serviceArn;
  if (existing) {
    console.log("既存App Runnerサービスを更新します。");
    const result = await clients.appRunner.send(new UpdateServiceCommand({
      ServiceArn: existing.ServiceArn,
      SourceConfiguration: sourceConfiguration,
      InstanceConfiguration: {
        Cpu: "1 vCPU",
        Memory: "2 GB",
        InstanceRoleArn: instanceRole.Arn,
      },
      HealthCheckConfiguration: { Protocol: "HTTP", Path: "/health" },
    }));
    serviceArn = result.Service.ServiceArn;
  } else {
    console.log("App Runnerサービスを作成します。IAM反映を待機中...");
    await sleep(10000);
    const result = await clients.appRunner.send(new CreateServiceCommand({
      ServiceName: SERVICE_NAME,
      SourceConfiguration: sourceConfiguration,
      InstanceConfiguration: {
        Cpu: "1 vCPU",
        Memory: "2 GB",
        InstanceRoleArn: instanceRole.Arn,
      },
      HealthCheckConfiguration: { Protocol: "HTTP", Path: "/health" },
    }));
    serviceArn = result.Service.ServiceArn;
  }

  const { serviceUrl } = await waitForService(serviceArn);
  const origin = `https://${serviceUrl}`;
  await updateBucketCors(origin);
  console.log(`\n公開完了: ${origin}/`);
}

main().catch(error => {
  console.error("\nデプロイ失敗:", error.message);
  if (error.$metadata?.requestId) console.error(`AWS request ID: ${error.$metadata.requestId}`);
  process.exitCode = 1;
});
