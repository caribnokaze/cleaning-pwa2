const crypto = require("crypto");
const express = require("express");
const {
  DeleteObjectsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const REGION = process.env.AWS_REGION || "ap-northeast-1";
const BUCKET = process.env.S3_BUCKET || "";
const APP_PASSWORD = process.env.APP_PASSWORD || "";
const AUTH_SECRET = process.env.AUTH_SECRET || "";
const PORT = Number(process.env.PORT || 8080);
const TOKEN_TTL_SECONDS = 60 * 60;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;
const MOBILE_TEST_PREFIX = "_system/mobile-test/";
const PRODUCTION_CONTRACT_PREFIX = `${MOBILE_TEST_PREFIX}production-contract/`;
const PRESIGNED_URL_TTL_SECONDS = 5 * 60;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 100 * MAX_FILE_BYTES;
const ALLOWED_PHOTO_IDS = new Set([
  "photos_amenity",
  "photos_general",
  "photos_filter",
  ...Array.from({ length: 8 }, (_, index) => `regular_${index + 1}`),
]);

function validateConfiguration() {
  if (REGION !== "ap-northeast-1") {
    throw new Error("AWS_REGION must be ap-northeast-1");
  }
  if (!/^tocoro-mobile-staging-\d{12}-ap-northeast-1$/.test(BUCKET)) {
    throw new Error("S3_BUCKET must be an isolated tocoro-mobile-staging bucket");
  }
  if (APP_PASSWORD.length < 8) {
    throw new Error("APP_PASSWORD must contain at least 8 characters");
  }
  if (AUTH_SECRET.length < 32) {
    throw new Error("AUTH_SECRET must contain at least 32 characters");
  }
  if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
    throw new Error("PORT is invalid");
  }
}

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(String(left)).digest();
  const rightHash = crypto.createHash("sha256").update(String(right)).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createToken(nowSeconds = Math.floor(Date.now() / 1000)) {
  const expiresAt = nowSeconds + TOKEN_TTL_SECONDS;
  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(String(expiresAt))
    .digest("hex");
  return `${expiresAt}.${signature}`;
}

function isValidToken(token = "", nowSeconds = Math.floor(Date.now() / 1000)) {
  const [expiresAt, signature] = String(token).split(".");
  if (!/^\d+$/.test(expiresAt || "") || !/^[a-f0-9]{64}$/.test(signature || "")) {
    return false;
  }
  if (Number(expiresAt) <= nowSeconds) return false;
  const expected = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(expiresAt)
    .digest("hex");
  return safeEqual(signature, expected);
}

function isSafePathSegment(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    !/[\\/\0]/.test(value)
  );
}

function validateUploadRequest(body) {
  const { runId, date, site, staff, files } = body || {};
  return (
    /^[a-z0-9_-]{8,64}$/i.test(runId || "") &&
    /^\d{4}-\d{2}-\d{2}$/.test(date || "") &&
    isSafePathSegment(site) &&
    isSafePathSegment(staff) &&
    Array.isArray(files) &&
    files.length >= 1 &&
    files.length <= 100 &&
    files.every((file) => /^\d{3}\.jpg$/i.test(String(file?.filename || "")))
  );
}

function isSafeIdentifier(value, maxLength = 128) {
  return (
    typeof value === "string" &&
    value.length >= 8 &&
    value.length <= maxLength &&
    /^[a-z0-9_-]+$/i.test(value)
  );
}

function validateProductionUploadRequest(body) {
  const { uploadId, date, site, staff, photoId, files } = body || {};
  return (
    isSafeIdentifier(uploadId, 64) &&
    /^\d{4}-\d{2}-\d{2}$/.test(date || "") &&
    isSafePathSegment(site) &&
    isSafePathSegment(staff) &&
    ALLOWED_PHOTO_IDS.has(photoId) &&
    Array.isArray(files) &&
    files.length >= 1 &&
    files.length <= 100 &&
    files.every(
      (file) =>
        isSafeIdentifier(file?.clientPhotoId) &&
        file?.contentType === "image/jpeg" &&
        Number.isInteger(file?.size) &&
        file.size >= 1 &&
        file.size <= MAX_FILE_BYTES,
    ) &&
    new Set(files.map((file) => file.clientPhotoId)).size === files.length &&
    files.reduce((total, file) => total + file.size, 0) <= MAX_REQUEST_BYTES
  );
}

function productionFilename(uploadId, clientPhotoId) {
  return `mobile_${uploadId}_${clientPhotoId}.jpg`;
}

function clientPhotoIdFromFilename(uploadId, filename) {
  const prefix = `mobile_${uploadId}_`;
  return filename.startsWith(prefix) && filename.endsWith(".jpg")
    ? filename.slice(prefix.length, -4)
    : "";
}

function createApp({ s3 = new S3Client({ region: REGION }), signer = getSignedUrl } = {}) {
  validateConfiguration();
  const app = express();
  const loginAttempts = new Map();

  app.disable("x-powered-by");
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.use((req, res, next) => {
    res.set({
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "no-referrer",
    });
    next();
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "tocoro-mobile-staging-api" });
  });

  app.post("/api/mobile/login", (req, res) => {
    const now = Date.now();
    const attempts = (loginAttempts.get(req.ip) || []).filter(
      (timestamp) => timestamp > now - LOGIN_WINDOW_MS,
    );
    if (attempts.length >= MAX_LOGIN_ATTEMPTS) {
      loginAttempts.set(req.ip, attempts);
      return res.status(429).json({ error: "ログイン試行回数が上限に達しました" });
    }
    if (!safeEqual(req.body?.password || "", APP_PASSWORD)) {
      attempts.push(now);
      loginAttempts.set(req.ip, attempts);
      return res.status(attempts.length >= MAX_LOGIN_ATTEMPTS ? 429 : 401).json({
        error:
          attempts.length >= MAX_LOGIN_ATTEMPTS
            ? "ログイン試行回数が上限に達しました"
            : "パスワードが違います",
      });
    }
    loginAttempts.delete(req.ip);
    const token = createToken();
    res.json({ token, expiresAt: Number(token.split(".")[0]) });
  });

  function requireMobileAuth(req, res, next) {
    const match = String(req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match || !isValidToken(match[1])) {
      return res.status(401).json({ error: "ログインが必要です" });
    }
    next();
  }

  app.use("/api/mobile-test", requireMobileAuth);
  app.use("/api/mobile/photos", requireMobileAuth);
  app.use("/api/mobile/uploads", requireMobileAuth);

  async function listAllObjects(prefix) {
    const objects = [];
    let continuationToken;
    do {
      const result = await s3.send(
        new ListObjectsV2Command({
          Bucket: BUCKET,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      objects.push(...(result.Contents || []));
      continuationToken = result.IsTruncated ? result.NextContinuationToken : undefined;
    } while (continuationToken);
    return objects;
  }

  async function deleteAllObjects(prefix) {
    const objects = await listAllObjects(prefix);
    let deletedCount = 0;
    for (let start = 0; start < objects.length; start += 1000) {
      const batch = objects.slice(start, start + 1000).filter((item) => item.Key);
      if (!batch.length) continue;
      const result = await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: batch.map((item) => ({ Key: item.Key })), Quiet: false },
        }),
      );
      if (result.Errors?.length) throw new Error("S3 deletion was incomplete");
      deletedCount += result.Deleted?.length || batch.length;
    }
    return deletedCount;
  }

  app.post("/api/mobile-test/presigned-urls", async (req, res) => {
    try {
      if (!validateUploadRequest(req.body)) {
        return res.status(400).json({ error: "テスト送信情報が不正です" });
      }
      const { runId, date, site, staff, files } = req.body;
      const targets = await Promise.all(
        files.map(async ({ filename }) => {
          const key = `${MOBILE_TEST_PREFIX}${runId}/${date}/${site}/${staff}/${filename}`;
          const uploadUrl = await signer(
            s3,
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: key,
              ContentType: "image/jpeg",
            }),
            { expiresIn: 900 },
          );
          return { key, uploadUrl };
        }),
      );
      res.json(targets);
    } catch (error) {
      console.error("Presigned URL generation failed", error?.name || "UnknownError");
      res.status(500).json({ error: "テスト用送信URLを生成できませんでした" });
    }
  });

  app.get("/api/mobile-test/runs/:runId", async (req, res) => {
    try {
      const runId = String(req.params.runId || "");
      if (!/^[a-z0-9_-]{8,64}$/i.test(runId)) {
        return res.status(400).json({ error: "テストIDが不正です" });
      }
      const prefix = `${MOBILE_TEST_PREFIX}${runId}/`;
      const objects = (await listAllObjects(prefix)).filter(
        (item) => item.Key && !item.Key.endsWith("/"),
      );
      const firstParts = objects[0]?.Key?.slice(prefix.length).split("/") || [];
      res.json({
        runId,
        date: firstParts[0] || "",
        site: firstParts[1] || "",
        staff: firstParts[2] || "",
        photoCount: objects.length,
        totalBytes: objects.reduce((total, item) => total + (item.Size || 0), 0),
        filenames: objects
          .map((item) => item.Key?.split("/").pop() || "")
          .filter(Boolean)
          .sort(),
      });
    } catch (error) {
      console.error("Run verification failed", error?.name || "UnknownError");
      res.status(500).json({ error: "テスト写真を確認できませんでした" });
    }
  });

  app.delete("/api/mobile-test/runs/:runId", async (req, res) => {
    try {
      const runId = String(req.params.runId || "");
      if (!/^[a-z0-9_-]{8,64}$/i.test(runId)) {
        return res.status(400).json({ error: "テストIDが不正です" });
      }
      const deletedCount = await deleteAllObjects(`${MOBILE_TEST_PREFIX}${runId}/`);
      res.json({ deletedCount });
    } catch (error) {
      console.error("Run deletion failed", error?.name || "UnknownError");
      res.status(500).json({ error: "テスト写真を削除できませんでした" });
    }
  });

  app.post("/api/mobile/photos/presigned-urls", async (req, res) => {
    try {
      if (!validateProductionUploadRequest(req.body)) {
        return res.status(400).json({ error: "送信情報が不正です" });
      }
      const { uploadId, date, site, staff, photoId, files } = req.body;
      const targets = await Promise.all(
        files.map(async ({ clientPhotoId }) => {
          const filename = productionFilename(uploadId, clientPhotoId);
          const key = `${PRODUCTION_CONTRACT_PREFIX}${uploadId}/${date}/${site}/${staff}/${photoId}/${filename}`;
          const uploadUrl = await signer(
            s3,
            new PutObjectCommand({
              Bucket: BUCKET,
              Key: key,
              ContentType: "image/jpeg",
            }),
            { expiresIn: PRESIGNED_URL_TTL_SECONDS },
          );
          return { clientPhotoId, filename, key, uploadUrl };
        }),
      );
      res.json({
        uploadId,
        expiresAt: Math.floor(Date.now() / 1000) + PRESIGNED_URL_TTL_SECONDS,
        files: targets,
      });
    } catch (error) {
      console.error("Mobile presigned URL generation failed", error?.name || "UnknownError");
      res.status(500).json({ error: "送信URLを生成できませんでした" });
    }
  });

  app.post("/api/mobile/photos/confirm", async (req, res) => {
    try {
      const uploadId = String(req.body?.uploadId || "");
      const requested = Array.isArray(req.body?.photos)
        ? req.body.photos.map((photo) => String(photo?.clientPhotoId || ""))
        : [];
      if (
        !isSafeIdentifier(uploadId, 64) ||
        requested.length < 1 ||
        requested.length > 100 ||
        requested.some((clientPhotoId) => !isSafeIdentifier(clientPhotoId)) ||
        new Set(requested).size !== requested.length
      ) {
        return res.status(400).json({ error: "確定情報が不正です" });
      }
      const objects = await listAllObjects(`${PRODUCTION_CONTRACT_PREFIX}${uploadId}/`);
      const stored = new Set(
        objects
          .map((item) => clientPhotoIdFromFilename(uploadId, item.Key?.split("/").pop() || ""))
          .filter(Boolean),
      );
      res.json({
        uploadId,
        confirmed: requested.filter((clientPhotoId) => stored.has(clientPhotoId)),
        missing: requested.filter((clientPhotoId) => !stored.has(clientPhotoId)),
      });
    } catch (error) {
      console.error("Mobile upload confirmation failed", error?.name || "UnknownError");
      res.status(500).json({ error: "送信結果を確定できませんでした" });
    }
  });

  app.get("/api/mobile/uploads/:uploadId", async (req, res) => {
    try {
      const uploadId = String(req.params.uploadId || "");
      if (!isSafeIdentifier(uploadId, 64)) {
        return res.status(400).json({ error: "送信IDが不正です" });
      }
      const objects = await listAllObjects(`${PRODUCTION_CONTRACT_PREFIX}${uploadId}/`);
      const confirmed = objects
        .map((item) => clientPhotoIdFromFilename(uploadId, item.Key?.split("/").pop() || ""))
        .filter(Boolean)
        .sort();
      res.json({
        uploadId,
        confirmed,
        totalBytes: objects.reduce((total, item) => total + (item.Size || 0), 0),
      });
    } catch (error) {
      console.error("Mobile upload lookup failed", error?.name || "UnknownError");
      res.status(500).json({ error: "送信状態を確認できませんでした" });
    }
  });

  app.delete("/api/mobile-test/production-contract/:uploadId", async (req, res) => {
    try {
      const uploadId = String(req.params.uploadId || "");
      if (!isSafeIdentifier(uploadId, 64)) {
        return res.status(400).json({ error: "送信IDが不正です" });
      }
      const deletedCount = await deleteAllObjects(
        `${PRODUCTION_CONTRACT_PREFIX}${uploadId}/`,
      );
      res.json({ deletedCount });
    } catch (error) {
      console.error("Production-contract test deletion failed", error?.name || "UnknownError");
      res.status(500).json({ error: "テスト写真を削除できませんでした" });
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}

if (require.main === module) {
  const app = createApp();
  app.listen(PORT, () => console.log(`Mobile staging API listening on ${PORT}`));
}

module.exports = {
  createApp,
  createToken,
  isSafePathSegment,
  isSafeIdentifier,
  isValidToken,
  productionFilename,
  safeEqual,
  validateConfiguration,
  validateProductionUploadRequest,
  validateUploadRequest,
};
