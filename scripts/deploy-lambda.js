const DEPLOY_TARGET = process.env.DEPLOY_TARGET || "production";
const IS_MOBILE_STAGING = DEPLOY_TARGET === "mobile-staging";
if (!IS_MOBILE_STAGING && DEPLOY_TARGET !== "production") {
  throw new Error(`未対応のDEPLOY_TARGETです: ${DEPLOY_TARGET}`);
}
require("dotenv").config({
  path: IS_MOBILE_STAGING ? ".env.mobile-staging" : ".env",
});
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
  SetRepositoryPolicyCommand,
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
  LambdaClient,
  CreateFunctionCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  CreateFunctionUrlConfigCommand,
  GetFunctionUrlConfigCommand,
  UpdateFunctionUrlConfigCommand,
  AddPermissionCommand,
} = require("@aws-sdk/client-lambda");
const {
  S3Client,
  CreateBucketCommand,
  HeadBucketCommand,
  GetBucketCorsCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const BUCKET =
  process.env.S3_BUCKET ||
  "tocoro-cleaning-report-881224647732-ap-northeast-1-an";
const FUNCTION_NAME = IS_MOBILE_STAGING
  ? "tocoro-mobile-staging"
  : "tocoro-cleaning-report";
const REPOSITORY_NAME = IS_MOBILE_STAGING
  ? "tocoro-mobile-staging"
  : "tocoro-cleaning-report-lambda";
const ROLE_NAME = IS_MOBILE_STAGING
  ? "TocoroMobileStagingLambdaRole"
  : "TocoroCleaningLambdaRole";
const LOGIN_ATTEMPTS_PREFIX = IS_MOBILE_STAGING
  ? "_system/mobile-staging/login-attempts"
  : "_system/login-attempts";
const APP_PASSWORD_SECRET = IS_MOBILE_STAGING
  ? "tocoro-mobile-staging/app-password"
  : "tocoro-cleaning/app-password";
const AUTH_SECRET_NAME = IS_MOBILE_STAGING
  ? "tocoro-mobile-staging/auth-secret"
  : "tocoro-cleaning/auth-secret";
const IMAGE_TAG = "latest";

if (!process.env.APP_PASSWORD || !process.env.AUTH_SECRET) {
  throw new Error(
    ".envにAPP_PASSWORDとAUTH_SECRETを設定してください。",
  );
}
if (
  process.env.APP_PASSWORD.length < 8 ||
  process.env.AUTH_SECRET.length < 32
) {
  throw new Error(
    "APP_PASSWORDは8文字以上、AUTH_SECRETは32文字以上にしてください。",
  );
}
if (
  IS_MOBILE_STAGING &&
  !/^tocoro-mobile-staging-[0-9]{12}-ap-northeast-1$/.test(BUCKET)
) {
  throw new Error(
    "検証用S3_BUCKETは tocoro-mobile-staging-[12桁のAWSアカウントID]-ap-northeast-1 にしてください。",
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clients = {
  sts: new STSClient({ region: REGION }),
  ecr: new ECRClient({ region: REGION }),
  iam: new IAMClient({ region: REGION }),
  secrets: new SecretsManagerClient({ region: REGION }),
  lambda: new LambdaClient({ region: REGION }),
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
  if (result.status !== 0) {
    throw new Error(`${command}が終了コード${result.status}で失敗しました。`);
  }
}

async function getOrCreateRepository() {
  try {
    const result = await clients.ecr.send(
      new DescribeRepositoriesCommand({
        repositoryNames: [REPOSITORY_NAME],
      }),
    );
    return result.repositories[0];
  } catch (error) {
    if (error.name !== "RepositoryNotFoundException") throw error;
    const result = await clients.ecr.send(
      new CreateRepositoryCommand({
        repositoryName: REPOSITORY_NAME,
        imageScanningConfiguration: { scanOnPush: true },
        imageTagMutability: "MUTABLE",
      }),
    );
    return result.repository;
  }
}

async function allowLambdaToPullImage(accountId) {
  await clients.ecr.send(
    new SetRepositoryPolicyCommand({
      repositoryName: REPOSITORY_NAME,
      force: true,
      policyText: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Sid: "LambdaECRImageRetrievalPolicy",
            Effect: "Allow",
            Principal: { Service: "lambda.amazonaws.com" },
            Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
            Condition: {
              StringLike: {
                "aws:SourceArn": `arn:aws:lambda:${REGION}:${accountId}:function:${FUNCTION_NAME}`,
              },
            },
          },
        ],
      }),
    }),
  );
}

async function putSecret(name, value) {
  try {
    const result = await clients.secrets.send(
      new DescribeSecretCommand({ SecretId: name }),
    );
    await clients.secrets.send(
      new PutSecretValueCommand({ SecretId: name, SecretString: value }),
    );
    return result.ARN;
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    const result = await clients.secrets.send(
      new CreateSecretCommand({
        Name: name,
        SecretString: value,
      }),
    );
    return result.ARN;
  }
}

async function getOrCreateRole() {
  let role;
  let created = false;
  try {
    const result = await clients.iam.send(
      new GetRoleCommand({ RoleName: ROLE_NAME }),
    );
    role = result.Role;
  } catch (error) {
    if (error.name !== "NoSuchEntityException") throw error;
    const result = await clients.iam.send(
      new CreateRoleCommand({
        RoleName: ROLE_NAME,
        AssumeRolePolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
      }),
    );
    role = result.Role;
    created = true;
  }

  if (IS_MOBILE_STAGING) {
    await clients.iam.send(
      new PutRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyName: "TocoroMobileStagingLambdaLogs",
        PolicyDocument: JSON.stringify({
          Version: "2012-10-17",
          Statement: [{
            Effect: "Allow",
            Action: [
              "logs:CreateLogGroup",
              "logs:CreateLogStream",
              "logs:PutLogEvents",
            ],
            Resource: "arn:aws:logs:*:*:*",
          }],
        }),
      }),
    );
  } else {
    await clients.iam.send(
      new AttachRolePolicyCommand({
        RoleName: ROLE_NAME,
        PolicyArn:
          "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole",
      }),
    );
  }

  return { role, created };
}

async function setRolePolicy(passwordSecretArn, authSecretArn) {
  await clients.iam.send(
    new PutRolePolicyCommand({
      RoleName: ROLE_NAME,
      PolicyName: IS_MOBILE_STAGING
        ? "TocoroMobileStagingLambdaDataAccess"
        : "TocoroCleaningLambdaDataAccess",
      PolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Action: ["s3:ListBucket"],
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
    }),
  );
}

async function ensureBucket() {
  try {
    await clients.s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
    return;
  } catch (error) {
    if (error.$metadata?.httpStatusCode !== 404 && error.name !== "NotFound") {
      throw error;
    }
  }

  const input = { Bucket: BUCKET };
  if (REGION !== "us-east-1") {
    input.CreateBucketConfiguration = { LocationConstraint: REGION };
  }
  await clients.s3.send(new CreateBucketCommand(input));
}

async function setStagingBucketLifecycle() {
  if (!IS_MOBILE_STAGING) return;
  await clients.s3.send(
    new PutBucketLifecycleConfigurationCommand({
      Bucket: BUCKET,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: "expire-mobile-test-uploads",
            Status: "Enabled",
            Filter: { Prefix: "_system/mobile-test/" },
            Expiration: { Days: 1 },
          },
          {
            ID: "expire-mobile-login-attempts",
            Status: "Enabled",
            Filter: { Prefix: LOGIN_ATTEMPTS_PREFIX },
            Expiration: { Days: 1 },
          },
        ],
      },
    }),
  );
}

async function waitForFunctionReady() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await clients.lambda.send(
      new GetFunctionConfigurationCommand({
        FunctionName: FUNCTION_NAME,
      }),
    );
    const stateReady = result.State === "Active";
    const updateReady =
      !result.LastUpdateStatus || result.LastUpdateStatus === "Successful";
    process.stdout.write(
      `\rLambda: ${result.State || "Unknown"} / ${result.LastUpdateStatus || "Ready"}   `,
    );
    if (result.State === "Failed" || result.LastUpdateStatus === "Failed") {
      throw new Error(
        result.StateReason ||
          result.LastUpdateStatusReason ||
          "Lambdaの更新に失敗しました。",
      );
    }
    if (stateReady && updateReady) {
      process.stdout.write("\n");
      return;
    }
    await sleep(3000);
  }
  throw new Error("Lambdaの準備完了を待機中にタイムアウトしました。");
}

async function deployFunction(imageUri, roleArn, secretArns) {
  const environment = {
    Variables: {
      NODE_ENV: "production",
      DEPLOY_TARGET,
      S3_BUCKET: BUCKET,
      APP_PASSWORD_SECRET_ID: secretArns.password,
      AUTH_SECRET_ID: secretArns.auth,
      LOGIN_ATTEMPTS_PREFIX,
      AWS_LWA_INVOKE_MODE: "response_stream",
      AWS_LWA_READINESS_CHECK_PATH: "/health",
    },
  };

  let exists = true;
  try {
    await clients.lambda.send(
      new GetFunctionCommand({ FunctionName: FUNCTION_NAME }),
    );
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    exists = false;
  }

  if (!exists) {
    await clients.lambda.send(
      new CreateFunctionCommand({
        FunctionName: FUNCTION_NAME,
        PackageType: "Image",
        Code: { ImageUri: imageUri },
        Role: roleArn,
        Architectures: ["x86_64"],
        MemorySize: 512,
        Timeout: 900,
        EphemeralStorage: { Size: 1024 },
        Environment: environment,
        Description: "TOCORO cleaning report web application",
      }),
    );
    await waitForFunctionReady();
    return;
  }

  await clients.lambda.send(
    new UpdateFunctionCodeCommand({
      FunctionName: FUNCTION_NAME,
      ImageUri: imageUri,
      Publish: false,
    }),
  );
  await waitForFunctionReady();
  await clients.lambda.send(
    new UpdateFunctionConfigurationCommand({
      FunctionName: FUNCTION_NAME,
      Role: roleArn,
      MemorySize: 512,
      Timeout: 900,
      EphemeralStorage: { Size: 1024 },
      Environment: environment,
      Description: "TOCORO cleaning report web application",
    }),
  );
  await waitForFunctionReady();
}

async function getOrCreateFunctionUrl() {
  let result;
  try {
    await clients.lambda.send(
      new GetFunctionUrlConfigCommand({ FunctionName: FUNCTION_NAME }),
    );
    result = await clients.lambda.send(
      new UpdateFunctionUrlConfigCommand({
        FunctionName: FUNCTION_NAME,
        AuthType: "NONE",
        InvokeMode: "RESPONSE_STREAM",
      }),
    );
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    result = await clients.lambda.send(
      new CreateFunctionUrlConfigCommand({
        FunctionName: FUNCTION_NAME,
        AuthType: "NONE",
        InvokeMode: "RESPONSE_STREAM",
      }),
    );
  }

  const permissions = [
    {
      StatementId: "FunctionURLAllowPublicAccess",
      Action: "lambda:InvokeFunctionUrl",
      FunctionUrlAuthType: "NONE",
    },
    {
      StatementId: "FunctionURLInvokeAllowPublicAccess",
      Action: "lambda:InvokeFunction",
      InvokedViaFunctionUrl: true,
    },
  ];
  for (const permission of permissions) {
    try {
      await clients.lambda.send(
        new AddPermissionCommand({
          FunctionName: FUNCTION_NAME,
          Principal: "*",
          ...permission,
        }),
      );
    } catch (error) {
      if (error.name !== "ResourceConflictException") throw error;
    }
  }

  return result.FunctionUrl;
}

async function updateBucketCors(origin) {
  let rules = [];
  try {
    const result = await clients.s3.send(
      new GetBucketCorsCommand({ Bucket: BUCKET }),
    );
    rules = result.CORSRules || [];
  } catch (error) {
    if (error.name !== "NoSuchCORSConfiguration") throw error;
  }

  rules = rules.filter((rule) => rule.ID !== "tocoro-lambda");
  rules.push({
    ID: "tocoro-lambda",
    AllowedOrigins: [origin],
    AllowedMethods: ["GET", "HEAD", "PUT"],
    AllowedHeaders: ["*"],
    ExposeHeaders: ["ETag"],
    MaxAgeSeconds: 3600,
  });
  await clients.s3.send(
    new PutBucketCorsCommand({
      Bucket: BUCKET,
      CORSConfiguration: { CORSRules: rules },
    }),
  );
}

async function main() {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  console.log(`AWS account: ${identity.Account} / region: ${REGION}`);

  if (IS_MOBILE_STAGING) {
    const expectedBucket = `tocoro-mobile-staging-${identity.Account}-${REGION}`;
    if (REGION !== "ap-northeast-1" || BUCKET !== expectedBucket) {
      throw new Error(
        `検証環境の安全チェックに失敗しました。S3_BUCKETは ${expectedBucket} にしてください。`,
      );
    }
    console.log("Deploy target: isolated mobile staging");
  }

  await ensureBucket();
  await setStagingBucketLifecycle();

  const repository = await getOrCreateRepository();
  await allowLambdaToPullImage(identity.Account);
  const auth = await clients.ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = auth.authorizationData[0];
  const [, password] = Buffer.from(authData.authorizationToken, "base64")
    .toString("utf8")
    .split(":");
  run(
    "docker",
    [
      "login",
      "--username",
      "AWS",
      "--password-stdin",
      authData.proxyEndpoint,
    ],
    { input: `${password}\n` },
  );

  const localImage = `${REPOSITORY_NAME}:${IMAGE_TAG}`;
  const remoteImage = `${repository.repositoryUri}:${IMAGE_TAG}`;
  run("docker", [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    "Dockerfile.lambda",
    "-t",
    localImage,
    ".",
  ]);
  run("docker", ["tag", localImage, remoteImage]);
  run("docker", ["push", remoteImage]);

  const [passwordSecretArn, authSecretArn] = await Promise.all([
    putSecret(APP_PASSWORD_SECRET, process.env.APP_PASSWORD),
    putSecret(AUTH_SECRET_NAME, process.env.AUTH_SECRET),
  ]);
  const { role, created } = await getOrCreateRole();
  await setRolePolicy(passwordSecretArn, authSecretArn);
  if (created) {
    console.log("IAMロールの反映を待機しています...");
    await sleep(10000);
  }

  await deployFunction(remoteImage, role.Arn, {
    password: passwordSecretArn,
    auth: authSecretArn,
  });
  const functionUrl = await getOrCreateFunctionUrl();
  const origin = new URL(functionUrl).origin;
  await updateBucketCors(origin);

  const healthUrl = new URL("/health", functionUrl);
  let health = "未確認";
  try {
    const response = await fetch(healthUrl);
    health = response.ok ? "OK" : `HTTP ${response.status}`;
  } catch (error) {
    health = `確認失敗: ${error.message}`;
  }

  console.log(`\nLambda公開URL: ${functionUrl}`);
  console.log(`ヘルスチェック: ${health}`);
}

main().catch((error) => {
  console.error("\nLambdaデプロイ失敗:", error.message);
  if (error.$metadata?.requestId) {
    console.error(`AWS request ID: ${error.$metadata.requestId}`);
  }
  process.exitCode = 1;
});
