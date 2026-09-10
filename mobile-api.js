const crypto = require("crypto");
const {
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  PutObjectCommand,
} = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");

const ALLOWED_PHOTO_IDS = new Set([
  "photos_amenity",
  "photos_general",
  "photos_filter",
  ...Array.from({ length: 8 }, (_, index) => `regular_${index + 1}`),
]);
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_REQUEST_BYTES = 100 * MAX_FILE_BYTES;
const URL_TTL_SECONDS = 5 * 60;
const MANIFEST_TTL_SECONDS = 7 * 24 * 60 * 60;

function isSafeId(value) {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(value);
}

function isSafePathSegment(value) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    !/[\\/\0]/.test(value)
  );
}

function manifestKey(uploadId) {
  const digest = crypto.createHash("sha256").update(uploadId).digest("hex");
  return `_system/mobile-uploads/${digest}.json`;
}

async function bodyToString(body) {
  if (!body) return "";
  if (typeof body.transformToString === "function") return body.transformToString();
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

function createMobileApiRouter({
  express,
  s3Client,
  bucketName,
  signUrl = getSignedUrl,
  reportOptions = { staff: [], sites: [] },
}) {
  const router = express.Router();
  const allowedStaff = new Set(reportOptions.staff.map((item) => item.value));
  const allowedSites = new Set(reportOptions.sites);

  router.get("/report-options", (_req, res) => {
    res.set("Cache-Control", "no-store");
    res.json(reportOptions);
  });

  async function readManifest(uploadId) {
    try {
      const result = await s3Client.send(
        new GetObjectCommand({ Bucket: bucketName, Key: manifestKey(uploadId) }),
      );
      const manifest = JSON.parse(await bodyToString(result.Body));
      if (Number(manifest.expiresAt) <= Math.floor(Date.now() / 1000)) {
        await s3Client.send(
          new DeleteObjectCommand({ Bucket: bucketName, Key: manifestKey(uploadId) }),
        );
        return null;
      }
      return manifest;
    } catch (error) {
      if (error?.name === "NoSuchKey" || error?.$metadata?.httpStatusCode === 404) {
        return null;
      }
      throw error;
    }
  }

  async function inspectFiles(manifest, requestedIds) {
    const requested = requestedIds ? new Set(requestedIds) : null;
    const confirmed = [];
    const missing = [];
    let totalBytes = 0;

    for (const file of manifest.files) {
      if (requested && !requested.has(file.clientPhotoId)) continue;
      try {
        const result = await s3Client.send(
          new HeadObjectCommand({ Bucket: bucketName, Key: file.key }),
        );
        if (
          result.ContentType === "image/jpeg" &&
          Number(result.ContentLength) > 0 &&
          Number(result.ContentLength) <= file.size
        ) {
          confirmed.push(file.clientPhotoId);
          totalBytes += Number(result.ContentLength);
        } else {
          missing.push(file.clientPhotoId);
        }
      } catch (error) {
        if (error?.name === "NotFound" || error?.$metadata?.httpStatusCode === 404) {
          missing.push(file.clientPhotoId);
        } else {
          throw error;
        }
      }
    }
    return { confirmed, missing, totalBytes };
  }

  router.post("/photos/presigned-urls", async (req, res) => {
    try {
      const { uploadId, date, site, staff, photoId, filterMinutes, files } =
        req.body || {};
      const validFilterMinutes =
        photoId !== "photos_filter" ||
        (Number.isInteger(filterMinutes) &&
          filterMinutes >= 15 &&
          filterMinutes <= 120 &&
          filterMinutes % 15 === 0);
      const totalBytes = Array.isArray(files)
        ? files.reduce((sum, file) => sum + Number(file?.size || 0), 0)
        : 0;
      const validFiles =
        Array.isArray(files) &&
        files.length >= 1 &&
        files.length <= 100 &&
        new Set(files.map((file) => file?.clientPhotoId)).size === files.length &&
        files.every(
          (file) =>
            isSafeId(file?.clientPhotoId) &&
            file?.contentType === "image/jpeg" &&
            Number.isInteger(file?.size) &&
            file.size >= 1 &&
            file.size <= MAX_FILE_BYTES,
        ) &&
        totalBytes <= MAX_REQUEST_BYTES;

      if (
        !isSafeId(uploadId) ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
        !isSafePathSegment(site) ||
        !isSafePathSegment(staff) ||
        !allowedSites.has(site) ||
        !allowedStaff.has(staff) ||
        !ALLOWED_PHOTO_IDS.has(photoId) ||
        !validFilterMinutes ||
        !validFiles
      ) {
        return res.status(400).json({ error: "アップロード情報が不正です" });
      }

      const suffix = photoId === "photos_filter" ? `_${filterMinutes}min` : "";
      const incomingFiles = files.map((file) => {
        const filename = `mobile_${uploadId}_${file.clientPhotoId}${suffix}.jpg`;
        return {
          clientPhotoId: file.clientPhotoId,
          size: file.size,
          filename,
          key: `${date}/${site}/${staff}/${photoId}/${filename}`,
        };
      });
      let manifest = {
        version: 1,
        uploadId,
        date,
        site,
        staff,
        photoId,
        filterMinutes: photoId === "photos_filter" ? filterMinutes : null,
        createdAt: new Date().toISOString(),
        expiresAt: Math.floor(Date.now() / 1000) + MANIFEST_TTL_SECONDS,
        files: incomingFiles,
      };

      const existing = await readManifest(uploadId);
      if (existing) {
        const sameMetadata =
          existing.date === date &&
          existing.site === site &&
          existing.staff === staff &&
          existing.photoId === photoId &&
          existing.filterMinutes === manifest.filterMinutes;
        const existingById = new Map(
          existing.files.map((file) => [file.clientPhotoId, file]),
        );
        const sameFiles = incomingFiles.every((file) => {
          const saved = existingById.get(file.clientPhotoId);
          return saved && saved.size === file.size && saved.key === file.key;
        });
        if (!sameMetadata || !sameFiles) {
          return res.status(409).json({ error: "同じ送信IDの内容が一致しません" });
        }
        manifest = existing;
      } else {
        await s3Client.send(
          new PutObjectCommand({
            Bucket: bucketName,
            Key: manifestKey(uploadId),
            Body: JSON.stringify(manifest),
            ContentType: "application/json",
          }),
        );
      }

      const expiresAt = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
      const requestedIds = new Set(incomingFiles.map((file) => file.clientPhotoId));
      const targets = await Promise.all(
        manifest.files.filter((file) => requestedIds.has(file.clientPhotoId)).map(async (file) => ({
          clientPhotoId: file.clientPhotoId,
          filename: file.filename,
          key: file.key,
          uploadUrl: await signUrl(
            s3Client,
            new PutObjectCommand({
              Bucket: bucketName,
              Key: file.key,
              ContentType: "image/jpeg",
            }),
            { expiresIn: URL_TTL_SECONDS },
          ),
        })),
      );
      res.set("Cache-Control", "no-store");
      res.json({ uploadId, expiresAt, files: targets });
    } catch (error) {
      console.error("Mobile presigned URL generation failed:", error);
      res.status(500).json({ error: "送信URLを作成できませんでした" });
    }
  });

  router.get("/uploads/:uploadId", async (req, res) => {
    try {
      if (!isSafeId(req.params.uploadId)) {
        return res.status(400).json({ error: "送信IDが不正です" });
      }
      const manifest = await readManifest(req.params.uploadId);
      if (!manifest) {
        return res.json({ uploadId: req.params.uploadId, confirmed: [], missing: [], totalBytes: 0 });
      }
      const result = await inspectFiles(manifest);
      res.set("Cache-Control", "no-store");
      res.json({ uploadId: manifest.uploadId, ...result });
    } catch (error) {
      console.error("Mobile upload status failed:", error);
      res.status(500).json({ error: "送信状態を確認できませんでした" });
    }
  });

  router.post("/photos/confirm", async (req, res) => {
    try {
      const { uploadId, photos } = req.body || {};
      const requestedIds = Array.isArray(photos)
        ? photos.map((photo) => photo?.clientPhotoId)
        : [];
      if (
        !isSafeId(uploadId) ||
        requestedIds.length < 1 ||
        requestedIds.length > 100 ||
        requestedIds.some((id) => !isSafeId(id)) ||
        new Set(requestedIds).size !== requestedIds.length
      ) {
        return res.status(400).json({ error: "送信確認情報が不正です" });
      }
      const manifest = await readManifest(uploadId);
      if (!manifest) return res.status(404).json({ error: "送信情報がありません" });
      const knownIds = new Set(manifest.files.map((file) => file.clientPhotoId));
      if (requestedIds.some((id) => !knownIds.has(id))) {
        return res.status(409).json({ error: "送信情報と写真が一致しません" });
      }
      const result = await inspectFiles(manifest, requestedIds);
      res.set("Cache-Control", "no-store");
      res.json({ uploadId, confirmed: result.confirmed, missing: result.missing });
    } catch (error) {
      console.error("Mobile upload confirmation failed:", error);
      res.status(500).json({ error: "送信完了を確認できませんでした" });
    }
  });

  return router;
}

module.exports = { createMobileApiRouter };
