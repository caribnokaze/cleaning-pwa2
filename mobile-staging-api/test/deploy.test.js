const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AWS_REGION = "ap-northeast-1";
process.env.S3_BUCKET = "tocoro-mobile-staging-000000000000-ap-northeast-1";
process.env.APP_PASSWORD = "test-password";
process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";

const { validateLocalConfiguration } = require("../scripts/deploy");

test("accepts the caller account staging bucket only", () => {
  assert.doesNotThrow(() => validateLocalConfiguration("000000000000"));
  assert.throws(() => validateLocalConfiguration("111111111111"), /S3_BUCKET/);
});
