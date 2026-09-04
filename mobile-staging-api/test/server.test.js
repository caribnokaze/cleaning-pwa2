const test = require("node:test");
const assert = require("node:assert/strict");

process.env.AWS_REGION = "ap-northeast-1";
process.env.S3_BUCKET = "tocoro-mobile-staging-000000000000-ap-northeast-1";
process.env.APP_PASSWORD = "test-password";
process.env.AUTH_SECRET = "0123456789abcdef0123456789abcdef";

const {
  createApp,
  createToken,
  isSafeIdentifier,
  isSafePathSegment,
  isValidToken,
  productionFilename,
  validateConfiguration,
  validateProductionUploadRequest,
  validateUploadRequest,
} = require("../server");

test("accepts only isolated staging configuration", () => {
  assert.doesNotThrow(validateConfiguration);
});

test("creates expiring authentication tokens", () => {
  const token = createToken(1_000);
  assert.equal(isValidToken(token, 1_001), true);
  assert.equal(isValidToken(token, 260_199), true);
  assert.equal(isValidToken(token, 260_201), false);
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

test("validates production-shaped upload requests", () => {
  const valid = {
    uploadId: "ios-12345678",
    date: "2026-09-04",
    site: "現場A",
    staff: "担当A",
    photoId: "photos_general",
    files: [
      { clientPhotoId: "photo-0001", contentType: "image/jpeg", size: 70_000 },
      { clientPhotoId: "photo-0002", contentType: "image/jpeg", size: 80_000 },
    ],
  };
  assert.equal(validateProductionUploadRequest(valid), true);
  assert.equal(validateProductionUploadRequest({ ...valid, photoId: "unknown" }), false);
  assert.equal(
    validateProductionUploadRequest({
      ...valid,
      files: [{ clientPhotoId: "photo-0001", contentType: "image/png", size: 70_000 }],
    }),
    false,
  );
  assert.equal(
    validateProductionUploadRequest({
      ...valid,
      files: [valid.files[0], valid.files[0]],
    }),
    false,
  );
});

test("creates deterministic safe production filenames", () => {
  assert.equal(isSafeIdentifier("photo-0001"), true);
  assert.equal(isSafeIdentifier("../photo"), false);
  assert.equal(
    productionFilename("ios-12345678", "photo-0001"),
    "mobile_ios-12345678_photo-0001.jpg",
  );
});

test("returns Retry-After when login attempts reach the limit", async (t) => {
  const app = createApp();
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await fetch(`${baseUrl}/api/mobile/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("retry-after"), null);
  }

  const limited = await fetch(`${baseUrl}/api/mobile/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(limited.status, 429);
  const retryAfter = Number(limited.headers.get("retry-after"));
  assert.ok(retryAfter >= 599 && retryAfter <= 600);
  assert.deepEqual(await limited.json(), {
    error: "ログイン試行回数が上限に達しました",
    retryAfterSeconds: retryAfter,
  });
});

test("supports the production-shaped authenticated upload flow", async (t) => {
  const storedObjects = [];
  const s3 = {
    async send(command) {
      if (command.constructor.name === "ListObjectsV2Command") {
        return {
          Contents: storedObjects.filter((item) => item.Key.startsWith(command.input.Prefix)),
          IsTruncated: false,
        };
      }
      if (command.constructor.name === "DeleteObjectsCommand") {
        const keys = new Set(command.input.Delete.Objects.map((item) => item.Key));
        const deleted = storedObjects.filter((item) => keys.has(item.Key));
        for (let index = storedObjects.length - 1; index >= 0; index -= 1) {
          if (keys.has(storedObjects[index].Key)) storedObjects.splice(index, 1);
        }
        return { Deleted: deleted.map((item) => ({ Key: item.Key })) };
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`);
    },
  };
  const signer = async (_client, command) =>
    `https://staging-upload.invalid/${encodeURIComponent(command.input.Key)}`;
  const app = createApp({ s3, signer });
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const unauthorized = await fetch(`${baseUrl}/api/mobile/uploads/ios-12345678`);
  assert.equal(unauthorized.status, 401);

  const login = await fetch(`${baseUrl}/api/mobile/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "test-password" }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

  const signed = await fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      uploadId: "ios-12345678",
      date: "2026-09-04",
      site: "現場A",
      staff: "担当A",
      photoId: "photos_general",
      files: [{ clientPhotoId: "photo-0001", contentType: "image/jpeg", size: 70_000 }],
    }),
  });
  assert.equal(signed.status, 200);
  const signedBody = await signed.json();
  assert.equal(signedBody.uploadId, "ios-12345678");
  assert.equal(signedBody.files[0].clientPhotoId, "photo-0001");
  assert.match(signedBody.files[0].key, /^_system\/mobile-test\/production-contract\//);
  storedObjects.push({ Key: signedBody.files[0].key, Size: 70_000 });

  const confirmation = await fetch(`${baseUrl}/api/mobile/photos/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      uploadId: "ios-12345678",
      photos: [{ clientPhotoId: "photo-0001" }, { clientPhotoId: "photo-0002" }],
    }),
  });
  assert.equal(confirmation.status, 200);
  assert.deepEqual(await confirmation.json(), {
    uploadId: "ios-12345678",
    confirmed: ["photo-0001"],
    missing: ["photo-0002"],
  });

  const lookup = await fetch(`${baseUrl}/api/mobile/uploads/ios-12345678`, { headers });
  assert.equal(lookup.status, 200);
  assert.deepEqual(await lookup.json(), {
    uploadId: "ios-12345678",
    confirmed: ["photo-0001"],
    totalBytes: 70_000,
  });

  const deletion = await fetch(
    `${baseUrl}/api/mobile-test/production-contract/ios-12345678`,
    { method: "DELETE", headers },
  );
  assert.equal(deletion.status, 200);
  assert.deepEqual(await deletion.json(), { deletedCount: 1 });
  assert.equal(storedObjects.length, 0);
});
