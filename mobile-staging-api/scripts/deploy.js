require("dotenv").config({ path: ".env.mobile-staging" });

const { spawnSync } = require("node:child_process");
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
  PutRolePolicyCommand,
} = require("@aws-sdk/client-iam");
const {
  SecretsManagerClient,
  CreateSecretCommand,
  DescribeSecretCommand,
  PutSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  LambdaClient,
  AddPermissionCommand,
  CreateFunctionCommand,
  CreateFunctionUrlConfigCommand,
  GetFunctionCommand,
  GetFunctionConfigurationCommand,
  GetFunctionUrlConfigCommand,
  UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand,
  UpdateFunctionUrlConfigCommand,
} = require("@aws-sdk/client-lambda");
const {
  S3Client,
  GetBucketLifecycleConfigurationCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
} = require("@aws-sdk/client-s3");

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const BUCKET = process.env.S3_BUCKET || "";
const FUNCTION_NAME = "tocoro-mobile-staging-api";
const REPOSITORY_NAME = "tocoro-mobile-staging-api";
const ROLE_NAME = "TocoroMobileStagingApiLambdaRole";
const PASSWORD_SECRET = "tocoro-mobile-staging-api/app-password";
const AUTH_SECRET = "tocoro-mobile-staging-api/auth-secret";
const TEST_PREFIX = "_system/mobile-test/";
const IMAGE_TAG = "latest";

function validateLocalConfiguration(accountId) {
  const expectedBucket = `tocoro-mobile-staging-${accountId}-${REGION}`;
  if (REGION !== "ap-northeast-1" || BUCKET !== expectedBucket) {
    throw new Error(`S3_BUCKET must be ${expectedBucket}`);
  }
  if ((process.env.APP_PASSWORD || "").length < 8) {
    throw new Error("APP_PASSWORD must contain at least 8 characters");
  }
  if ((process.env.AUTH_SECRET || "").length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
}

const clients = {
  sts: new STSClient({ region: REGION }),
  ecr: new ECRClient({ region: REGION }),
  iam: new IAMClient({ region: REGION }),
  secrets: new SecretsManagerClient({ region: REGION }),
  lambda: new LambdaClient({ region: REGION }),
  s3: new S3Client({ region: REGION }),
};

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function run(command, args, input) {
  console.log(`> ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
    input,
    encoding: "utf8",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

async function ensureBucketSafety() {
  await clients.s3.send(new HeadBucketCommand({ Bucket: BUCKET }));
  await clients.s3.send(new PutPublicAccessBlockCommand({
    Bucket: BUCKET,
    PublicAccessBlockConfiguration: {
      BlockPublicAcls: true,
      IgnorePublicAcls: true,
      BlockPublicPolicy: true,
      RestrictPublicBuckets: true,
    },
  }));

  let rules = [];
  try {
    const result = await clients.s3.send(
      new GetBucketLifecycleConfigurationCommand({ Bucket: BUCKET }),
    );
    rules = result.Rules || [];
  } catch (error) {
    if (error.name !== "NoSuchLifecycleConfiguration") throw error;
  }
  rules = rules.filter((rule) => rule.ID !== "expire-mobile-test-uploads");
  rules.push({
    ID: "expire-mobile-test-uploads",
    Status: "Enabled",
    Filter: { Prefix: TEST_PREFIX },
    Expiration: { Days: 1 },
  });
  await clients.s3.send(new PutBucketLifecycleConfigurationCommand({
    Bucket: BUCKET,
    LifecycleConfiguration: { Rules: rules },
  }));
}

async function ensureRepository(accountId) {
  let repository;
  try {
    const result = await clients.ecr.send(new DescribeRepositoriesCommand({
      repositoryNames: [REPOSITORY_NAME],
    }));
    [repository] = result.repositories;
  } catch (error) {
    if (error.name !== "RepositoryNotFoundException") throw error;
    const result = await clients.ecr.send(new CreateRepositoryCommand({
      repositoryName: REPOSITORY_NAME,
      imageScanningConfiguration: { scanOnPush: true },
      imageTagMutability: "MUTABLE",
    }));
    repository = result.repository;
  }
  await clients.ecr.send(new SetRepositoryPolicyCommand({
    repositoryName: REPOSITORY_NAME,
    force: true,
    policyText: JSON.stringify({
      Version: "2012-10-17",
      Statement: [{
        Sid: "LambdaPullOnly",
        Effect: "Allow",
        Principal: { Service: "lambda.amazonaws.com" },
        Action: ["ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer"],
        Condition: {
          ArnLike: {
            "aws:SourceArn": `arn:aws:lambda:${REGION}:${accountId}:function:${FUNCTION_NAME}`,
          },
        },
      }],
    }),
  }));
  return repository;
}

async function putSecret(name, value) {
  try {
    const existing = await clients.secrets.send(new DescribeSecretCommand({ SecretId: name }));
    await clients.secrets.send(new PutSecretValueCommand({
      SecretId: name,
      SecretString: value,
    }));
    return existing.ARN;
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    const created = await clients.secrets.send(new CreateSecretCommand({
      Name: name,
      SecretString: value,
    }));
    return created.ARN;
  }
}

async function ensureRole(accountId, secretArns) {
  let role;
  let created = false;
  try {
    const result = await clients.iam.send(new GetRoleCommand({ RoleName: ROLE_NAME }));
    role = result.Role;
  } catch (error) {
    if (error.name !== "NoSuchEntityException") throw error;
    const result = await clients.iam.send(new CreateRoleCommand({
      RoleName: ROLE_NAME,
      AssumeRolePolicyDocument: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
          Effect: "Allow",
          Principal: { Service: "lambda.amazonaws.com" },
          Action: "sts:AssumeRole",
        }],
      }),
    }));
    role = result.Role;
    created = true;
  }

  await clients.iam.send(new PutRolePolicyCommand({
    RoleName: ROLE_NAME,
    PolicyName: "TocoroMobileStagingApiRuntime",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        {
          Sid: "WriteLogs",
          Effect: "Allow",
          Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"],
          Resource: `arn:aws:logs:${REGION}:${accountId}:*`,
        },
        {
          Sid: "ListTestObjectsOnly",
          Effect: "Allow",
          Action: "s3:ListBucket",
          Resource: `arn:aws:s3:::${BUCKET}`,
          Condition: { StringLike: { "s3:prefix": `${TEST_PREFIX}*` } },
        },
        {
          Sid: "ManageTestObjectsOnly",
          Effect: "Allow",
          Action: ["s3:PutObject", "s3:DeleteObject"],
          Resource: `arn:aws:s3:::${BUCKET}/${TEST_PREFIX}*`,
        },
        {
          Sid: "ReadApiSecretsOnly",
          Effect: "Allow",
          Action: "secretsmanager:GetSecretValue",
          Resource: secretArns,
        },
      ],
    }),
  }));
  if (created) await sleep(10000);
  return role;
}

async function waitForFunction() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const result = await clients.lambda.send(new GetFunctionConfigurationCommand({
      FunctionName: FUNCTION_NAME,
    }));
    if (result.State === "Failed" || result.LastUpdateStatus === "Failed") {
      throw new Error(result.StateReason || result.LastUpdateStatusReason || "Lambda failed");
    }
    if (result.State === "Active" &&
        (!result.LastUpdateStatus || result.LastUpdateStatus === "Successful")) return;
    await sleep(3000);
  }
  throw new Error("Timed out waiting for Lambda");
}

async function deployFunction(imageUri, roleArn) {
  const environment = {
    Variables: {
      NODE_ENV: "production",
      S3_BUCKET: BUCKET,
      APP_PASSWORD_SECRET_ID: PASSWORD_SECRET,
      AUTH_SECRET_ID: AUTH_SECRET,
      AWS_LWA_INVOKE_MODE: "response_stream",
      AWS_LWA_READINESS_CHECK_PATH: "/health",
    },
  };
  let exists = true;
  try {
    await clients.lambda.send(new GetFunctionCommand({ FunctionName: FUNCTION_NAME }));
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    exists = false;
  }
  if (!exists) {
    await clients.lambda.send(new CreateFunctionCommand({
      FunctionName: FUNCTION_NAME,
      PackageType: "Image",
      Code: { ImageUri: imageUri },
      Role: roleArn,
      Architectures: ["x86_64"],
      MemorySize: 256,
      Timeout: 30,
      Environment: environment,
      Description: "Isolated TOCORO mobile staging API",
    }));
    await waitForFunction();
    return;
  }
  await clients.lambda.send(new UpdateFunctionCodeCommand({
    FunctionName: FUNCTION_NAME,
    ImageUri: imageUri,
    Publish: false,
  }));
  await waitForFunction();
  await clients.lambda.send(new UpdateFunctionConfigurationCommand({
    FunctionName: FUNCTION_NAME,
    Role: roleArn,
    MemorySize: 256,
    Timeout: 30,
    Environment: environment,
    Description: "Isolated TOCORO mobile staging API",
  }));
  await waitForFunction();
}

async function ensureFunctionUrl() {
  let result;
  try {
    await clients.lambda.send(new GetFunctionUrlConfigCommand({ FunctionName: FUNCTION_NAME }));
    result = await clients.lambda.send(new UpdateFunctionUrlConfigCommand({
      FunctionName: FUNCTION_NAME,
      AuthType: "NONE",
      InvokeMode: "RESPONSE_STREAM",
    }));
  } catch (error) {
    if (error.name !== "ResourceNotFoundException") throw error;
    result = await clients.lambda.send(new CreateFunctionUrlConfigCommand({
      FunctionName: FUNCTION_NAME,
      AuthType: "NONE",
      InvokeMode: "RESPONSE_STREAM",
    }));
  }
  for (const permission of [
    {
      StatementId: "AllowPublicFunctionUrl",
      Action: "lambda:InvokeFunctionUrl",
      FunctionUrlAuthType: "NONE",
    },
    {
      StatementId: "AllowPublicFunctionUrlInvoke",
      Action: "lambda:InvokeFunction",
      InvokedViaFunctionUrl: true,
    },
  ]) {
    try {
      await clients.lambda.send(new AddPermissionCommand({
        FunctionName: FUNCTION_NAME,
        Principal: "*",
        ...permission,
      }));
    } catch (error) {
      if (error.name !== "ResourceConflictException") throw error;
    }
  }
  return result.FunctionUrl;
}

async function main() {
  const identity = await clients.sts.send(new GetCallerIdentityCommand({}));
  validateLocalConfiguration(identity.Account);
  console.log(`Verified staging account ${identity.Account} in ${REGION}`);
  await ensureBucketSafety();
  const repository = await ensureRepository(identity.Account);

  const authorization = await clients.ecr.send(new GetAuthorizationTokenCommand({}));
  const authData = authorization.authorizationData[0];
  const [, password] = Buffer.from(authData.authorizationToken, "base64")
    .toString("utf8").split(":");
  run("docker", ["login", "--username", "AWS", "--password-stdin", authData.proxyEndpoint], `${password}\n`);
  const localImage = `${REPOSITORY_NAME}:${IMAGE_TAG}`;
  const remoteImage = `${repository.repositoryUri}:${IMAGE_TAG}`;
  run("docker", ["build", "--platform", "linux/amd64", "-t", localImage, "."]);
  run("docker", ["tag", localImage, remoteImage]);
  run("docker", ["push", remoteImage]);

  const secretArns = await Promise.all([
    putSecret(PASSWORD_SECRET, process.env.APP_PASSWORD),
    putSecret(AUTH_SECRET, process.env.AUTH_SECRET),
  ]);
  const role = await ensureRole(identity.Account, secretArns);
  await deployFunction(remoteImage, role.Arn);
  const functionUrl = await ensureFunctionUrl();
  const response = await fetch(new URL("/health", functionUrl));
  if (!response.ok) throw new Error(`Health check failed with HTTP ${response.status}`);
  console.log(`\nStaging API URL: ${functionUrl}`);
  console.log("Health check: OK");
}

if (require.main === module) {
  main().catch((error) => {
    console.error("\nDeployment failed:", error.message);
    process.exitCode = 1;
  });
}

module.exports = { validateLocalConfiguration };
