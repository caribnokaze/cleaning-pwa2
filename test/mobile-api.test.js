const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const express = require("express");
const { createMobileApiRouter } = require("../mobile-api");

function createHarness() {
  const objects = new Map();
  const s3Client = {
    async send(command) {
      const name = command.constructor.name;
      const { Key } = command.input;
      if (name === "PutObjectCommand") {
        objects.set(Key, {
          body: String(command.input.Body || ""),
          contentType: command.input.ContentType,
          size: Buffer.byteLength(String(command.input.Body || "")),
        });
        return {};
      }
      if (name === "GetObjectCommand") {
        const object = objects.get(Key);
        if (!object) throw Object.assign(new Error("missing"), { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } });
        return { Body: { transformToString: async () => object.body } };
      }
      if (name === "HeadObjectCommand") {
        const object = objects.get(Key);
        if (!object) throw Object.assign(new Error("missing"), { name: "NotFound", $metadata: { httpStatusCode: 404 } });
        return { ContentType: object.contentType, ContentLength: object.size };
      }
      if (name === "DeleteObjectCommand") {
        objects.delete(Key);
        return {};
      }
      throw new Error(`Unexpected command: ${name}`);
    },
  };
  const app = express();
  app.use(express.json());
  app.use("/api/mobile", createMobileApiRouter({
    express,
    s3Client,
    bucketName: "test-bucket",
    signUrl: async (_client, command) => `https://upload.invalid/${encodeURIComponent(command.input.Key)}`,
    reportOptions: {
      staff: [{ value: "担当者", label: "01 担当者" }],
      sites: ["テスト現場", "別現場"],
    },
  }));
  return { app, objects };
}

test("report options expose the same selectable values used by the Web form", async () => {
  const { app } = createHarness();
  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/mobile/report-options`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), {
      staff: [{ value: "担当者", label: "01 担当者" }],
      sites: ["テスト現場", "別現場"],
    });
  });
});

async function withServer(app, callback) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    await callback(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const generalRequest = {
  uploadId: "upload-12345678",
  date: "2026-09-10",
  site: "テスト現場",
  staff: "担当者",
  photoId: "photos_general",
  files: [
    { clientPhotoId: "photo-0001", contentType: "image/jpeg", size: 1000 },
    { clientPhotoId: "photo-0002", contentType: "image/jpeg", size: 1000 },
  ],
};

test("presign, partial resume, status and confirmation are idempotent", async () => {
  const { app, objects } = createHarness();
  await withServer(app, async (baseUrl) => {
    const first = await fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(generalRequest),
    });
    assert.equal(first.status, 200);
    const firstBody = await first.json();
    assert.equal(firstBody.files.length, 2);
    assert.match(firstBody.files[0].key, /^2026-09-10\/テスト現場\/担当者\/photos_general\/mobile_/);

    const retry = await fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...generalRequest, files: [generalRequest.files[1]] }),
    });
    assert.equal(retry.status, 200);
    assert.deepEqual((await retry.json()).files.map((file) => file.clientPhotoId), ["photo-0002"]);

    objects.set(firstBody.files[0].key, { body: "photo", contentType: "image/jpeg", size: 5 });
    const status = await fetch(`${baseUrl}/api/mobile/uploads/${generalRequest.uploadId}`);
    assert.deepEqual(await status.json(), {
      uploadId: generalRequest.uploadId,
      confirmed: ["photo-0001"],
      missing: ["photo-0002"],
      totalBytes: 5,
    });

    const confirm = await fetch(`${baseUrl}/api/mobile/photos/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        uploadId: generalRequest.uploadId,
        photos: generalRequest.files.map(({ clientPhotoId }) => ({ clientPhotoId })),
      }),
    });
    assert.deepEqual(await confirm.json(), {
      uploadId: generalRequest.uploadId,
      confirmed: ["photo-0001"],
      missing: ["photo-0002"],
    });
  });
});

test("filter uploads require a valid work duration and include it in filenames", async () => {
  const { app } = createHarness();
  await withServer(app, async (baseUrl) => {
    const invalid = await fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...generalRequest, uploadId: "filter-12345678", photoId: "photos_filter" }),
    });
    assert.equal(invalid.status, 400);

    const valid = await fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...generalRequest, uploadId: "filter-12345678", photoId: "photos_filter", filterMinutes: 30 }),
    });
    assert.equal(valid.status, 200);
    assert.match((await valid.json()).files[0].filename, /_30min\.jpg$/);
  });
});

test("an upload ID cannot be reused for different report metadata", async () => {
  const { app } = createHarness();
  await withServer(app, async (baseUrl) => {
    const post = (body) => fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal((await post(generalRequest)).status, 200);
    assert.equal((await post({ ...generalRequest, site: "別現場" })).status, 409);
  });
});

test("uploads reject staff or sites that are not present in the Web choices", async () => {
  const { app } = createHarness();
  await withServer(app, async (baseUrl) => {
    const post = (body) => fetch(`${baseUrl}/api/mobile/photos/presigned-urls`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal((await post({ ...generalRequest, staff: "自由入力" })).status, 400);
    assert.equal((await post({ ...generalRequest, site: "自由入力" })).status, 400);
  });
});
