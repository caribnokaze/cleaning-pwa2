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
  console.log("Smoke test: login, upload, verify, delete OK");
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
