const baseUrl = process.argv[2];
const password = process.env.APP_PASSWORD;
if (!baseUrl || !password) {
  throw new Error("Usage: APP_PASSWORD=... node scripts/smoke-test.js <staging-api-url>");
}

const runId = `smoke-${Date.now()}`;
let token = "";

async function request(path, options = {}) {
  const response = await fetch(new URL(path, baseUrl), options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

async function main() {
  const login = await request("/api/mobile/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  });
  token = login.token;
  const headers = {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  };
  const contractUploadId = `contract-${Date.now()}`;
  const contractSigned = await request("/api/mobile/photos/presigned-urls", {
    method: "POST",
    headers,
    body: JSON.stringify({
      uploadId: contractUploadId,
      date: "2026-09-04",
      site: "smoke-test",
      staff: "automated",
      photoId: "photos_general",
      files: [{
        clientPhotoId: "smoke-photo-0001",
        contentType: "image/jpeg",
        size: 4,
      }],
    }),
  });
  if (
    contractSigned.uploadId !== contractUploadId ||
    contractSigned.files?.length !== 1 ||
    !contractSigned.files[0].key.startsWith(
      `_system/mobile-test/production-contract/${contractUploadId}/`,
    )
  ) {
    throw new Error("Production-shaped presigned URL response is invalid");
  }
  const contractState = await request(`/api/mobile/uploads/${contractUploadId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (contractState.uploadId !== contractUploadId || contractState.confirmed?.length !== 0) {
    throw new Error("Production-shaped upload lookup failed");
  }
  const [target] = await request("/api/mobile-test/presigned-urls", {
    method: "POST",
    headers,
    body: JSON.stringify({
      runId,
      date: "2026-08-31",
      site: "smoke-test",
      staff: "automated",
      files: [{ filename: "001.jpg" }],
    }),
  });
  const upload = await fetch(target.uploadUrl, {
    method: "PUT",
    headers: { "content-type": "image/jpeg" },
    body: Buffer.from([0xff, 0xd8, 0xff, 0xd9]),
  });
  if (!upload.ok) throw new Error(`S3 upload failed with HTTP ${upload.status}`);
  const verified = await request(`/api/mobile-test/runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (verified.photoCount !== 1 || verified.totalBytes !== 4) {
    throw new Error("Uploaded object verification failed");
  }
  const deleted = await request(`/api/mobile-test/runs/${runId}`, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
  });
  if (deleted.deletedCount !== 1) throw new Error("Test object deletion failed");
  console.log("Smoke test: login, production-shaped contract, upload, verify, delete OK");
}

main().catch(async (error) => {
  if (token) {
    try {
      await request(`/api/mobile-test/runs/${runId}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` },
      });
    } catch {}
  }
  console.error("Smoke test failed:", error.message);
  process.exitCode = 1;
});
