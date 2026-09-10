const EXPECTED_PRODUCTION_ACCOUNT = "881224647732";
const EXPECTED_PRODUCTION_REGION = "ap-northeast-1";
const EXPECTED_PRODUCTION_BUCKET =
  "tocoro-cleaning-report-881224647732-ap-northeast-1-an";

function validateProductionConfiguration({
  deployTarget,
  region,
  bucket,
  approved,
  preflight = false,
}) {
  if (deployTarget !== "production") {
    throw new Error("本番操作には DEPLOY_TARGET=production の明示指定が必要です。");
  }
  if (region !== EXPECTED_PRODUCTION_REGION) {
    throw new Error(
      `本番リージョンは ${EXPECTED_PRODUCTION_REGION} に限定されています。`,
    );
  }
  if (bucket !== EXPECTED_PRODUCTION_BUCKET) {
    throw new Error(
      `本番S3_BUCKETは ${EXPECTED_PRODUCTION_BUCKET} に限定されています。`,
    );
  }
  if (!preflight && approved !== "true") {
    throw new Error(
      "本番デプロイには PRODUCTION_DEPLOY_APPROVED=true の明示指定が必要です。",
    );
  }
}

function validateProductionAccount(accountId) {
  if (accountId !== EXPECTED_PRODUCTION_ACCOUNT) {
    throw new Error(
      `AWSアカウントが本番予定の ${EXPECTED_PRODUCTION_ACCOUNT} と一致しません。`,
    );
  }
}

module.exports = {
  EXPECTED_PRODUCTION_ACCOUNT,
  EXPECTED_PRODUCTION_REGION,
  EXPECTED_PRODUCTION_BUCKET,
  validateProductionConfiguration,
  validateProductionAccount,
};
