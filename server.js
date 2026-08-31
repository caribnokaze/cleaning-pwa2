require("dotenv").config(); // .envファイルからAWSの鍵を読み込む
const express = require("express");
const archiver = require("archiver");
const crypto = require("crypto");
const path = require("path");
const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectsCommand,
} = require("@aws-sdk/client-s3");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const app = express();
const AUTH_COOKIE = "cleaning_auth";
const AUTH_TTL_SECONDS = 12 * 60 * 60;
let APP_PASSWORD = process.env.APP_PASSWORD || "";
let AUTH_SECRET = process.env.AUTH_SECRET || "";
const LOGIN_ATTEMPTS_PREFIX = process.env.LOGIN_ATTEMPTS_PREFIX || "";
const IS_MOBILE_STAGING = process.env.DEPLOY_TARGET === "mobile-staging";

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use((req, res, next) => {
  res.set({
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "same-origin",
    "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
  });
  next();
});

function safeEqual(left, right) {
  const leftHash = crypto.createHash("sha256").update(left).digest();
  const rightHash = crypto.createHash("sha256").update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

function createAuthToken() {
  const expiresAt = Math.floor(Date.now() / 1000) + AUTH_TTL_SECONDS;
  const signature = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(String(expiresAt))
    .digest("hex");
  return `${expiresAt}.${signature}`;
}

function isValidAuthToken(token = "") {
  const [expiresAt, signature] = token.split(".");
  if (
    !/^\d+$/.test(expiresAt || "") ||
    !/^[a-f0-9]{64}$/.test(signature || "")
  ) {
    return false;
  }
  if (Number(expiresAt) <= Math.floor(Date.now() / 1000)) return false;
  const expected = crypto
    .createHmac("sha256", AUTH_SECRET)
    .update(expiresAt)
    .digest("hex");
  return safeEqual(signature, expected);
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || "";
  for (const item of cookies.split(";")) {
    const [key, ...valueParts] = item.trim().split("=");
    if (key === name) return decodeURIComponent(valueParts.join("="));
  }
  return "";
}

function getRequestAuthToken(req) {
  const authorization = String(req.get("authorization") || "");
  const bearerMatch = authorization.match(/^Bearer\s+(.+)$/i);
  return bearerMatch?.[1] || getCookie(req, AUTH_COOKIE);
}

function authCookie(req, value, maxAge = AUTH_TTL_SECONDS) {
  const forwardedProto = req.get("x-forwarded-proto") || "";
  const secure = req.secure || forwardedProto.split(",")[0].trim() === "https";
  return [
    `${AUTH_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

const loginAttempts = new Map();
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_LOGIN_ATTEMPTS = 5;

function loginAttemptPrefix(ip) {
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
  return `${LOGIN_ATTEMPTS_PREFIX}/${ipHash}/`;
}

async function listLoginAttempts(ip) {
  const prefix = loginAttemptPrefix(ip);
  const cutoff = Date.now() - LOGIN_WINDOW_MS;
  const objects = (await listAllObjects(prefix)).filter(
    (item) => item.Key && (item.LastModified?.getTime() || 0) >= cutoff,
  );
  return objects;
}

async function loginAttemptState(ip) {
  if (LOGIN_ATTEMPTS_PREFIX) {
    const objects = await listLoginAttempts(ip);
    return { count: objects.length };
  }

  const now = Date.now();
  const current = loginAttempts.get(ip);
  if (!current || current.resetAt <= now) {
    const fresh = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, fresh);
    return fresh;
  }
  return current;
}

async function recordFailedLogin(ip) {
  if (LOGIN_ATTEMPTS_PREFIX) {
    await s3Client.send(
      new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: `${loginAttemptPrefix(ip)}${Date.now()}-${crypto.randomUUID()}`,
        Body: "",
        ContentType: "application/octet-stream",
      }),
    );
    return (await listLoginAttempts(ip)).length;
  }

  const state = await loginAttemptState(ip);
  state.count += 1;
  return state.count;
}

async function clearLoginAttempts(ip) {
  if (LOGIN_ATTEMPTS_PREFIX) {
    const objects = await listAllObjects(loginAttemptPrefix(ip));
    if (objects.length) {
      await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: {
            Objects: objects.map((item) => ({ Key: item.Key })),
            Quiet: true,
          },
        }),
      );
    }
    return;
  }
  loginAttempts.delete(ip);
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.get("/login", (req, res) => {
  if (isValidAuthToken(getCookie(req, AUTH_COOKIE))) return res.redirect("/");
  res.sendFile(path.join(__dirname, "login.html"));
});

app.post("/login", async (req, res) => {
  try {
    const state = await loginAttemptState(req.ip);
    if (state.count >= MAX_LOGIN_ATTEMPTS) {
      return res.redirect("/login?error=locked");
    }

    if (!safeEqual(String(req.body.password || ""), APP_PASSWORD)) {
      const count = await recordFailedLogin(req.ip);
      return res.redirect(
        count >= MAX_LOGIN_ATTEMPTS
          ? "/login?error=locked"
          : "/login?error=invalid",
      );
    }

    await clearLoginAttempts(req.ip);
    res.setHeader("Set-Cookie", authCookie(req, createAuthToken()));
    res.redirect("/");
  } catch (error) {
    console.error("Login processing failed:", error);
    res.status(500).send("ログイン処理に失敗しました。");
  }
});

app.post("/api/mobile/login", async (req, res) => {
  try {
    const state = await loginAttemptState(req.ip);
    if (state.count >= MAX_LOGIN_ATTEMPTS) {
      return res.status(429).json({ error: "ログイン試行回数が上限に達しました" });
    }

    if (!safeEqual(String(req.body.password || ""), APP_PASSWORD)) {
      const count = await recordFailedLogin(req.ip);
      return res.status(count >= MAX_LOGIN_ATTEMPTS ? 429 : 401).json({
        error:
          count >= MAX_LOGIN_ATTEMPTS
            ? "ログイン試行回数が上限に達しました"
            : "パスワードが違います",
      });
    }

    await clearLoginAttempts(req.ip);
    const token = createAuthToken();
    const expiresAt = Number(token.split(".")[0]);
    res.set("Cache-Control", "no-store");
    res.json({ token, expiresAt });
  } catch (error) {
    console.error("Mobile login processing failed:", error);
    res.status(500).json({ error: "ログイン処理に失敗しました" });
  }
});

app.get("/logout", (req, res) => {
  res.setHeader("Set-Cookie", authCookie(req, "", 0));
  res.redirect("/login");
});

app.use((req, res, next) => {
  if (isValidAuthToken(getRequestAuthToken(req))) return next();
  if (
    req.path.startsWith("/api/") ||
    req.path.startsWith("/get-presigned-url")
  ) {
    return res.status(401).json({ error: "ログインが必要です" });
  }
  res.redirect("/login");
});

app.get("/api/session", (req, res) => {
  const token = getRequestAuthToken(req);
  const expiresAt = Number(token.split(".")[0]);
  res.set("Cache-Control", "no-store");
  res.json({ authenticated: true, expiresAt });
});

app.use(express.static("."));

// AWS S3 クライアントの初期化（鍵は自動で.envから読み込まれます）
const AWS_REGION = process.env.AWS_REGION || "ap-northeast-1";
const s3Client = new S3Client({ region: AWS_REGION });
const BUCKET_NAME =
  process.env.S3_BUCKET ||
  "tocoro-cleaning-report-881224647732-ap-northeast-1-an";

async function listAllObjects(prefix = "") {
  const objects = [];
  let continuationToken;

  do {
    const result = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: BUCKET_NAME,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );

    objects.push(...(result.Contents || []));
    continuationToken = result.IsTruncated
      ? result.NextContinuationToken
      : undefined;
  } while (continuationToken);

  return objects;
}

function isSafePathSegment(value) {
  return (
    typeof value === "string" && value.length <= 100 && !/[\\/\0]/.test(value)
  );
}

function matchesReportScope(key, scope) {
  if (!scope) return true;
  const photoId = key.split("/")[3] || "";
  const isSpecial =
    photoId.startsWith("regular_") || photoId === "photos_filter";
  return scope === "special" ? isSpecial : !isSpecial;
}

// スマホから「このファイル名でアップロードしたい」という要求を受け付ける
app.post("/get-presigned-url", async (req, res) => {
  try {
    const { filename, contentType, date, site, staff, label, photoId } =
      req.body;

    if (!filename) {
      return res.status(400).json({ error: "Filename is required" });
    }

    // 保存先のキー（フォルダ構成）
    const key = `${date}/${site}/${staff}/${photoId}/${filename}`;

    // S3へアップロードする設定
    const command = new PutObjectCommand({
      Bucket: BUCKET_NAME,
      Key: key,
      ContentType: contentType || "image/jpeg",
    });

    // 5分間だけ有効なアップロード用URL（通行証）を生成
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

    const fileUrl = `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`;

    res.json({ uploadUrl, fileUrl });
  } catch (err) {
    console.error("S3用のURL生成に失敗しました:", err);
    res.status(500).json({ error: "Failed to generate signed URL" });
  }
});

app.post("/get-presigned-urls", async (req, res) => {
  try {
    const { date, site, staff, files } = req.body || {};

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !isSafePathSegment(site) ||
      !isSafePathSegment(staff) ||
      !site ||
      !staff ||
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > 250
    ) {
      return res.status(400).json({ error: "アップロード情報が不正です" });
    }

    const targets = await Promise.all(
      files.map(async (file) => {
        const { filename, photoId } = file || {};
        if (
          !/^(?:\d{3}|add_\d{13}_\d{3})(?:_\d+min)?\.jpg$/i.test(
            filename || "",
          ) ||
          !/^[a-z0-9_]+$/i.test(photoId || "")
        ) {
          throw new Error("Invalid upload filename or category");
        }

        const key = `${date}/${site}/${staff}/${photoId}/${filename}`;
        const uploadUrl = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: "image/jpeg",
          }),
          { expiresIn: 900 },
        );

        return {
          uploadUrl,
          fileUrl: `https://${BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${key}`,
        };
      }),
    );

    res.json(targets);
  } catch (err) {
    console.error("署名付きURLの一括生成に失敗しました:", err);
    res.status(400).json({ error: "署名付きURLの一括生成に失敗しました" });
  }
});

app.post("/api/mobile-test/presigned-urls", async (req, res) => {
  try {
    if (!IS_MOBILE_STAGING) {
      return res.status(404).json({ error: "Not found" });
    }

    const { runId, date, site, staff, files } = req.body || {};
    if (
      !/^[a-z0-9_-]{8,64}$/i.test(runId || "") ||
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !site ||
      !staff ||
      !isSafePathSegment(site) ||
      !isSafePathSegment(staff) ||
      !Array.isArray(files) ||
      files.length < 1 ||
      files.length > 100
    ) {
      return res.status(400).json({ error: "テスト送信情報が不正です" });
    }

    const targets = await Promise.all(
      files.map(async (file) => {
        const filename = String(file?.filename || "");
        if (!/^\d{3}\.jpg$/i.test(filename)) {
          throw new Error("Invalid mobile test filename");
        }

        const key = `_system/mobile-test/${runId}/${date}/${site}/${staff}/${filename}`;
        const uploadUrl = await getSignedUrl(
          s3Client,
          new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: key,
            ContentType: "image/jpeg",
          }),
          { expiresIn: 900 },
        );

        return { key, uploadUrl };
      }),
    );

    res.set("Cache-Control", "no-store");
    res.json(targets);
  } catch (error) {
    console.error("Mobile test presigned URL generation failed:", error);
    res.status(400).json({ error: "テスト用送信URLを生成できませんでした" });
  }
});

app.delete("/api/mobile-test/runs/:runId", async (req, res) => {
  try {
    if (!IS_MOBILE_STAGING) {
      return res.status(404).json({ error: "Not found" });
    }

    const runId = String(req.params.runId || "");
    if (!/^[a-z0-9_-]{8,64}$/i.test(runId)) {
      return res.status(400).json({ error: "テストIDが不正です" });
    }

    const objects = await listAllObjects(`_system/mobile-test/${runId}/`);
    let deletedCount = 0;
    for (let start = 0; start < objects.length; start += 1000) {
      const batch = objects.slice(start, start + 1000);
      if (!batch.length) continue;
      const result = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: {
            Objects: batch.map((item) => ({ Key: item.Key })),
            Quiet: false,
          },
        }),
      );
      if (result.Errors?.length) {
        throw new Error("Some mobile test objects could not be deleted");
      }
      deletedCount += result.Deleted?.length || batch.length;
    }

    res.json({ deletedCount });
  } catch (error) {
    console.error("Mobile test deletion failed:", error);
    res.status(500).json({ error: "テスト写真を削除できませんでした" });
  }
});

app.get("/api/mobile-test/runs/:runId", async (req, res) => {
  try {
    if (!IS_MOBILE_STAGING) {
      return res.status(404).json({ error: "Not found" });
    }

    const runId = String(req.params.runId || "");
    if (!/^[a-z0-9_-]{8,64}$/i.test(runId)) {
      return res.status(400).json({ error: "テストIDが不正です" });
    }

    const prefix = `_system/mobile-test/${runId}/`;
    const objects = (await listAllObjects(prefix)).filter(
      (item) => item.Key && !item.Key.endsWith("/"),
    );
    const firstParts = objects[0]?.Key?.slice(prefix.length).split("/") || [];
    res.set("Cache-Control", "no-store");
    res.json({
      runId,
      date: firstParts[0] || "",
      site: firstParts[1] || "",
      staff: firstParts[2] || "",
      photoCount: objects.length,
      totalBytes: objects.reduce((total, item) => total + (item.Size || 0), 0),
    });
  } catch (error) {
    console.error("Mobile test verification failed:", error);
    res.status(500).json({ error: "テスト写真を確認できませんでした" });
  }
});

app.get("/api/reports", async (req, res) => {
  try {
    const requestedDate = req.query.date || "";
    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res.status(400).json({ error: "清掃日の形式が不正です" });
    }

    const objects = await listAllObjects(
      requestedDate ? `${requestedDate}/` : "",
    );
    const reports = new Map();

    objects.forEach((item) => {
      if (!item.Key || item.Key.endsWith("/") || item.Key.startsWith("_system/")) return;
      const [date = "", site = "", staff = "", photoId = "", ...filenameParts] =
        item.Key.split("/");
      if (!date || !site || !staff || !photoId || !filenameParts.length) return;
      const scope =
        photoId.startsWith("regular_") || photoId === "photos_filter"
          ? "special"
          : "normal";
      const reportKey = `${date}\u0000${site}\u0000${staff}\u0000${scope}`;
      if (!reports.has(reportKey)) {
        reports.set(reportKey, {
          date,
          site,
          staff,
          scope,
          photoIds: new Set(),
          filterMinutes: "",
        });
      }
      const report = reports.get(reportKey);
      report.photoIds.add(photoId);
      if (photoId === "photos_filter" && !report.filterMinutes) {
        report.filterMinutes = filenameParts.join("/").match(/_(\d+)min\.jpg$/i)?.[1] || "";
      }
    });

    const result = [...reports.values()]
      .map((report) => ({ ...report, photoIds: [...report.photoIds] }))
      .sort(
        (a, b) =>
          b.date.localeCompare(a.date) ||
          a.site.localeCompare(b.site, "ja") ||
          a.staff.localeCompare(b.staff, "ja") ||
          a.scope.localeCompare(b.scope),
      );
    res.set("Cache-Control", "no-store");
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/photos", async (req, res) => {
  try {
    const requestedDate = req.query.date || "";
    const requestedSite = req.query.site || "";
    const requestedStaff = req.query.staff || "";
    const requestedScope = req.query.scope || "";
    if (requestedDate && !/^\d{4}-\d{2}-\d{2}$/.test(requestedDate)) {
      return res.status(400).json({ error: "清掃日の形式が不正です" });
    }
    if (!isSafePathSegment(requestedSite) || !isSafePathSegment(requestedStaff)) {
      return res.status(400).json({ error: "検索条件が不正です" });
    }
    if (requestedScope && !["normal", "special"].includes(requestedScope)) {
      return res.status(400).json({ error: "報告区分が不正です" });
    }

    // S3は1回につき最大1000件なので、全ページを取得する
    const prefix =
      requestedDate && requestedSite && requestedStaff
        ? `${requestedDate}/${requestedSite}/${requestedStaff}/`
        : requestedDate
          ? `${requestedDate}/`
          : "";
    const objects = (await listAllObjects(prefix)).filter((item) => {
      if (!item.Key) return false;
      const [date, site, staff] = item.Key.split("/");
      return (
        (!requestedDate || date === requestedDate) &&
        (!requestedSite || site === requestedSite) &&
        (!requestedStaff || staff === requestedStaff) &&
        matchesReportScope(item.Key, requestedScope)
      );
    });

    const photos = await Promise.all(
      objects
        .filter(
          (item) =>
            item.Key &&
            !item.Key.endsWith("/") &&
            !item.Key.startsWith("_system/"),
        )
        .map(async (item) => {
          const parts = item.Key.split("/");
          const [date = "", site = "", staff = "", photoId = ""] = parts;
          const filename = parts.slice(4).join("/") || parts.at(-1);
          const getParams = { Bucket: BUCKET_NAME, Key: item.Key };

          const [url, downloadUrl] = await Promise.all([
            getSignedUrl(s3Client, new GetObjectCommand(getParams), {
              expiresIn: 3600,
            }),
            getSignedUrl(
              s3Client,
              new GetObjectCommand({
                ...getParams,
                ResponseContentDisposition: `attachment; filename="${filename.replace(/["\\]/g, "_")}"`,
              }),
              { expiresIn: 3600 },
            ),
          ]);

          return {
            key: item.Key,
            date,
            site,
            staff,
            photoId,
            filename,
            size: item.Size || 0,
            lastModified: item.LastModified,
            url,
            downloadUrl,
          };
        }),
    );

    photos.sort(
      (a, b) =>
        b.date.localeCompare(a.date) ||
        a.site.localeCompare(b.site, "ja") ||
        a.staff.localeCompare(b.staff, "ja") ||
        a.key.localeCompare(b.key, "ja", { numeric: true }),
    );

    res.set("Cache-Control", "no-store");
    res.json(photos);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/photos/download", async (req, res) => {
  try {
    const { date, site = "", staff = "", scope = "" } = req.query;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) {
      return res.status(400).json({ error: "清掃日を指定してください" });
    }
    if (!isSafePathSegment(site) || !isSafePathSegment(staff)) {
      return res.status(400).json({ error: "検索条件が不正です" });
    }
    if (scope && !["normal", "special"].includes(scope)) {
      return res.status(400).json({ error: "報告区分が不正です" });
    }

    const prefix =
      site && staff
        ? `${date}/${site}/${staff}/`
        : site
          ? `${date}/${site}/`
          : `${date}/`;

    const objects = (await listAllObjects(prefix)).filter((item) => {
      if (!item.Key || item.Key.endsWith("/")) return false;
      const [itemDate, itemSite, itemStaff] = item.Key.split("/");
      return (
        itemDate === date &&
        (!site || itemSite === site) &&
        (!staff || itemStaff === staff) &&
        matchesReportScope(item.Key, scope)
      );
    });

    if (!objects.length) {
      return res.status(404).json({ error: "条件に一致する写真がありません" });
    }

    const photoIds = new Set(
      objects.map((item) => item.Key?.split("/")[3]).filter(Boolean),
    );
    const hasRegular = [...photoIds].some((photoId) =>
      photoId.startsWith("regular_"),
    );
    const hasFilter = photoIds.has("photos_filter");
    const cleaningType =
      hasRegular && hasFilter
        ? "定期清掃＋フィルター清掃"
        : hasRegular
          ? "定期清掃"
          : hasFilter
            ? "フィルター清掃"
            : "通常清掃";
    const compactDate = date.slice(2).replaceAll("-", "");
    const archiveName = `${[compactDate, site, cleaningType]
      .filter(Boolean)
      .join("_")
      .replace(/[^\p{L}\p{N}.＋_-]/gu, "_")}.zip`;
    res.set({
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
      "Cache-Control": "no-store",
    });

    const archive = archiver("zip", { store: true });
    archive.on("warning", (error) => console.warn("ZIP warning:", error));
    archive.on("error", (error) => {
      console.error("ZIP error:", error);
      if (!res.headersSent) res.status(500).end();
      else res.destroy(error);
    });
    req.on("aborted", () => archive.abort());
    archive.pipe(res);

    for (const item of objects) {
      const result = await s3Client.send(
        new GetObjectCommand({
          Bucket: BUCKET_NAME,
          Key: item.Key,
        }),
      );
      if (result.Body) {
        const [, , , photoId, ...filenameParts] = item.Key.split("/");
        const originalFilename = filenameParts.join("_");
        const filename =
          photoId === "photos_filter"
            ? originalFilename.replace(/_\d+min(?=\.jpg$)/i, "")
            : originalFilename;
        archive.append(result.Body, { name: `${photoId}_${filename}` });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error("一括ダウンロードに失敗しました:", err);
    if (!res.headersSent) {
      res.status(500).json({ error: "一括ダウンロードに失敗しました" });
    } else {
      res.destroy(err);
    }
  }
});

app.delete("/api/photos", async (req, res) => {
  try {
    const { keys, confirmation } = req.body || {};
    if (
      confirmation !== "削除" ||
      !Array.isArray(keys) ||
      keys.length < 1 ||
      keys.length > 100
    ) {
      return res.status(400).json({ error: "削除対象が不正です" });
    }

    const uniqueKeys = [...new Set(keys)];
    const allKeysAreValid = uniqueKeys.every((key) => {
      if (typeof key !== "string" || key.length > 500) return false;
      const [date, site, staff, photoId, ...filenameParts] = key.split("/");
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(date || "") &&
        Boolean(site && staff && photoId && filenameParts.length) &&
        isSafePathSegment(site) &&
        isSafePathSegment(staff) &&
        /^[a-z0-9_]+$/i.test(photoId)
      );
    });

    if (!allKeysAreValid) {
      return res.status(400).json({ error: "削除対象のキーが不正です" });
    }

    const result = await s3Client.send(
      new DeleteObjectsCommand({
        Bucket: BUCKET_NAME,
        Delete: {
          Objects: uniqueKeys.map((Key) => ({ Key })),
          Quiet: false,
        },
      }),
    );

    if (result.Errors?.length) {
      console.error("写真の個別削除エラー:", result.Errors);
      return res
        .status(500)
        .json({ error: "一部の写真を削除できませんでした" });
    }

    res.json({ deletedCount: result.Deleted?.length || uniqueKeys.length });
  } catch (err) {
    console.error("写真の個別削除に失敗しました:", err);
    res.status(500).json({ error: "写真の削除に失敗しました" });
  }
});

app.delete("/api/photos/report", async (req, res) => {
  try {
    const { date, site, staff, scope, confirmation } = req.body || {};

    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date || "") ||
      !site ||
      !staff ||
      !isSafePathSegment(site) ||
      !isSafePathSegment(staff) ||
      !["normal", "special"].includes(scope) ||
      confirmation !== "削除"
    ) {
      return res
        .status(400)
        .json({ error: "削除条件または確認文字が不正です" });
    }

    const prefix = `${date}/${site}/${staff}/`;
    const objects = (await listAllObjects(prefix)).filter(
      (item) =>
        item.Key &&
        !item.Key.endsWith("/") &&
        matchesReportScope(item.Key, scope),
    );

    if (!objects.length) {
      return res.status(404).json({ error: "削除対象の写真がありません" });
    }

    let deletedCount = 0;
    for (let i = 0; i < objects.length; i += 1000) {
      const batch = objects.slice(i, i + 1000);
      const result = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET_NAME,
          Delete: {
            Objects: batch.map((item) => ({ Key: item.Key })),
            Quiet: false,
          },
        }),
      );

      if (result.Errors?.length) {
        console.error("S3削除エラー:", result.Errors);
        return res.status(500).json({
          error: "一部の写真を削除できませんでした",
          deletedCount,
        });
      }
      deletedCount += result.Deleted?.length || batch.length;
    }

    res.json({ deletedCount });
  } catch (err) {
    console.error("報告写真の削除に失敗しました:", err);
    res.status(500).json({ error: "報告写真の削除に失敗しました" });
  }
});

async function loadSecret(secretId) {
  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || "ap-northeast-1",
  });
  const result = await client.send(
    new GetSecretValueCommand({ SecretId: secretId }),
  );
  return result.SecretString || "";
}

async function startServer() {
  if (!APP_PASSWORD && process.env.APP_PASSWORD_SECRET_ID) {
    APP_PASSWORD = await loadSecret(process.env.APP_PASSWORD_SECRET_ID);
  }
  if (!AUTH_SECRET && process.env.AUTH_SECRET_ID) {
    AUTH_SECRET = await loadSecret(process.env.AUTH_SECRET_ID);
  }
  if (APP_PASSWORD.length < 8 || AUTH_SECRET.length < 32) {
    throw new Error(
      "APP_PASSWORDは8文字以上、AUTH_SECRETは32文字以上で設定してください。",
    );
  }

  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`S3 Token Server running on port ${PORT}`);
  });
}

startServer().catch((error) => {
  console.error("Server startup failed:", error);
  process.exitCode = 1;
});
