const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AWS_REGION = "ap-northeast-1";
process.env.S3_BUCKET = "tocoro-mobile-staging-000000000000-ap-northeast-1";
process.env.APP_PASSWORD = "test-password";
process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";

const {
  createToken,
  isSafePathSegment,
  isValidToken,
  validateConfiguration,
  validateUploadRequest,
} = require("../server");

test("accepts only isolated staging configuration", () => {
  assert.doesNotThrow(validateConfiguration);
});

test("creates expiring authentication tokens", () => {
  const token = createToken(1_000);
  assert.equal(isValidToken(token, 1_001), true);
  assert.equal(isValidToken(token, 1_000 + 3_601), false);
  assert.equal(isValidToken(`${token}changed`, 1_001), false);
});

test("rejects unsafe S3 path segments", () => {
  assert.equal(isSafePathSegment("現場A"), true);
  assert.equal(isSafePathSegment("../production"), false);
  assert.equal(isSafePathSegment("site/name"), false);
  assert.equal(isSafePathSegment(""), false);
});

test("validates a batch of at most 100 jpeg names", () => {
  const valid = {
    runId: "android-12345678",
    date: "2026-08-31",
    site: "現場A",
    staff: "担当A",
    files: [{ filename: "001.jpg" }, { filename: "100.jpg" }],
  };
  assert.equal(validateUploadRequest(valid), true);
  assert.equal(validateUploadRequest({ ...valid, files: [{ filename: "../a.jpg" }] }), false);
  assert.equal(
    validateUploadRequest({
      ...valid,
      files: Array.from({ length: 101 }, (_, index) => ({
        filename: `${String(index + 1).padStart(3, "0")}.jpg`,
      })),
    }),
    false,
  );
});
