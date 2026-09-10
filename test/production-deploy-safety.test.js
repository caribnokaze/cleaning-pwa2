const assert = require("node:assert/strict");
const test = require("node:test");
const {
  EXPECTED_PRODUCTION_ACCOUNT,
  EXPECTED_PRODUCTION_BUCKET,
  EXPECTED_PRODUCTION_REGION,
  validateProductionAccount,
  validateProductionConfiguration,
} = require("../scripts/production-deploy-safety");

const valid = {
  deployTarget: "production",
  region: EXPECTED_PRODUCTION_REGION,
  bucket: EXPECTED_PRODUCTION_BUCKET,
  approved: "true",
};

test("approved production configuration is accepted", () => {
  assert.doesNotThrow(() => validateProductionConfiguration(valid));
  assert.doesNotThrow(() => validateProductionAccount(EXPECTED_PRODUCTION_ACCOUNT));
});

test("preflight does not require mutation approval", () => {
  assert.doesNotThrow(() =>
    validateProductionConfiguration({ ...valid, approved: "", preflight: true }),
  );
});

test("deployment target, region, bucket and approval are all enforced", () => {
  assert.throws(() => validateProductionConfiguration({ ...valid, deployTarget: "" }));
  assert.throws(() => validateProductionConfiguration({ ...valid, region: "us-east-1" }));
  assert.throws(() => validateProductionConfiguration({ ...valid, bucket: "other" }));
  assert.throws(() => validateProductionConfiguration({ ...valid, approved: "false" }));
});

test("unexpected AWS account is rejected", () => {
  assert.throws(() => validateProductionAccount("000000000000"));
});
