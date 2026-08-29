require("dotenv").config();

const baseUrl = String(process.argv[2] || "").replace(/\/$/, "");

if (!baseUrl || !process.env.APP_PASSWORD) {
  throw new Error("Lambda URLとAPP_PASSWORDが必要です。");
}

async function main() {
  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ password: process.env.APP_PASSWORD }),
    redirect: "manual",
  });
  const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
  console.log(`LOGIN_STATUS=${login.status}`);
  console.log(`LOGIN_REDIRECT=${login.headers.get("location")}`);
  console.log(`AUTH_COOKIE_SET=${Boolean(cookie)}`);

  const mobileLogin = await fetch(`${baseUrl}/api/mobile/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: process.env.APP_PASSWORD }),
  });
  const mobileLoginBody = await mobileLogin.json();
  const mobileToken = mobileLoginBody.token || "";
  console.log(`MOBILE_LOGIN_STATUS=${mobileLogin.status}`);
  console.log(`MOBILE_TOKEN_SET=${Boolean(mobileToken)}`);
  if (!mobileLogin.ok || !mobileToken) {
    throw new Error("モバイル用トークンが発行されませんでした。");
  }
  if (!cookie) throw new Error("認証Cookieが設定されませんでした。");

  const home = await fetch(`${baseUrl}/`, {
    headers: { cookie },
    redirect: "manual",
  });
  const html = await home.text();
  console.log(`HOME_STATUS=${home.status}`);
  console.log(`HOME_FORM=${html.includes('id="staff"')}`);

  const galleryResponse = await fetch(`${baseUrl}/gallery.html`, { headers: { cookie } });
  const galleryHtml = await galleryResponse.text();
  console.log(`GALLERY_STATUS=${galleryResponse.status}`);
  console.log(`KEYWORD_FILTER_REMOVED=${!galleryHtml.includes('keywordFilter')}`);
  console.log(`STAFF_DISPLAY=${html.includes('id="staffDisplay"')}`);
  console.log(`STAFF_SUGGESTIONS=${html.includes('id="staffSuggestions"')}`);
  console.log(`SITE_DISPLAY=${html.includes('id="siteDisplay"')}`);
  console.log(`SITE_SUGGESTIONS=${html.includes('id="siteSuggestions"')}`);
  console.log(`STAFF_FIRST=${html.includes('label="01 今泉とき枝"')}`);
  console.log(`STAFF_LAST=${html.includes('label="88 宇治克哉"')}`);
  console.log(
    `STAFF_OPTION_COUNT=${(html.match(/<option value="[^"]+" label="\d{2} /g) || []).length}`,
  );
  const legacyStaff = [
    "SC1 加藤祐樹", "SC2 圓谷光希", "SC3 渡邊夕凛", "井上貴希",
    "北畑雅", "ロサン", "大西真登", "清水夏海", "柴崎日向",
  ];
  console.log(
    `LEGACY_STAFF_COUNT=${legacyStaff.filter((staff) => html.includes(`value="${staff}"`)).length}`,
  );
  console.log(`SESSION_SCRIPT=${html.includes('src="session.js"')}`);

  const sessionResponse = await fetch(`${baseUrl}/api/session`, {
    headers: { cookie },
    cache: "no-store",
  });
  const sessionBody = await sessionResponse.json();
  console.log(`SESSION_STATUS=${sessionResponse.status}`);
  console.log(`SESSION_EXPIRY_OK=${Number(sessionBody.expiresAt) * 1000 > Date.now()}`);

  const mobileSessionResponse = await fetch(`${baseUrl}/api/session`, {
    headers: { authorization: `Bearer ${mobileToken}` },
    cache: "no-store",
  });
  console.log(`MOBILE_SESSION_STATUS=${mobileSessionResponse.status}`);
  if (!mobileSessionResponse.ok) throw new Error("モバイル用セッションを確認できませんでした。");

  const expiredSession = await fetch(`${baseUrl}/api/session`, {
    redirect: "manual",
  });
  console.log(`EXPIRED_SESSION_STATUS=${expiredSession.status}`);

  const stylesheet = await fetch(`${baseUrl}/style.css`, { headers: { cookie } });
  const stylesheetText = await stylesheet.text();
  console.log(`SITE_OPTIONS_HIDDEN=${stylesheetText.includes("#siteOptions") && stylesheetText.includes("display: none")}`);

  const appScript = await fetch(`${baseUrl}/app.js`, { headers: { cookie } });
  const appScriptText = await appScript.text();
  console.log(`RANKED_SEARCH=${appScriptText.includes("rankSearchMatches")}`);
  console.log(`HIRAGANA_SEARCH=${appScriptText.includes("romanizeKana") && appScriptText.includes("siteSearchQueries")}`);

  const reportStartedAt = Date.now();
  const reportsResponse = await fetch(`${baseUrl}/api/reports?date=2026-08-04`, {
    headers: { cookie },
  });
  const reportsBody = await reportsResponse.json();
  console.log(`REPORT_LIST_STATUS=${reportsResponse.status}`);
  console.log(`REPORT_LIST_MS=${Date.now() - reportStartedAt}`);
  console.log(`REPORT_LIST_COUNT=${Array.isArray(reportsBody) ? reportsBody.length : -1}`);
  console.log(`REPORT_LIST_HAS_URL=${JSON.stringify(reportsBody).includes('"url"')}`);
  const firstReport = reportsBody[0];
  if (firstReport) {
    const detailParams = new URLSearchParams({
      date: firstReport.date,
      site: firstReport.site,
      staff: firstReport.staff,
      scope: firstReport.scope,
    });
    const detailResponse = await fetch(`${baseUrl}/api/photos?${detailParams}`, {
      headers: { cookie },
    });
    const detailBody = await detailResponse.json();
    console.log(`REPORT_DETAIL_STATUS=${detailResponse.status}`);
    console.log(`REPORT_DETAIL_COUNT=${Array.isArray(detailBody) ? detailBody.length : -1}`);
    console.log(`REPORT_DETAIL_HAS_URL=${Boolean(detailBody[0]?.url)}`);
  }

  const photos = await fetch(`${baseUrl}/api/photos?date=2099-01-01`, {
    headers: { cookie },
  });
  const photoBody = await photos.json();
  console.log(`S3_LIST_STATUS=${photos.status}`);
  console.log(`S3_LIST_EMPTY=${Array.isArray(photoBody) && photoBody.length === 0}`);

  if (process.argv.includes("--full")) {
    const startedAt = Date.now();
    const allPhotos = await fetch(`${baseUrl}/api/photos`, {
      headers: { cookie },
    });
    const allPhotoBody = await allPhotos.json();
    console.log(`FULL_LIST_STATUS=${allPhotos.status}`);
    console.log(`FULL_LIST_MS=${Date.now() - startedAt}`);
    console.log(
      `FULL_LIST_COUNT=${Array.isArray(allPhotoBody) ? allPhotoBody.length : -1}`,
    );
    if (!allPhotos.ok) {
      console.log(`FULL_LIST_ERROR=${allPhotoBody.error || "unknown"}`);
    }
  }

  const signed = await fetch(`${baseUrl}/get-presigned-urls`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({
      date: "2099-01-01",
      site: "lambda-check",
      staff: "lambda-check",
      files: [{ filename: "001.jpg", photoId: "photos_amenity" }],
    }),
  });
  const signedBody = await signed.json();
  console.log(`SIGNED_URL_STATUS=${signed.status}`);
  console.log(
    `SIGNED_URL_OK=${Boolean(signedBody[0]?.uploadUrl?.startsWith("https://"))}`,
  );
  const mobileRunId = `lambda-check-${Date.now()}`;
  const mobileSigned = await fetch(`${baseUrl}/api/mobile-test/presigned-urls`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${mobileToken}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      runId: mobileRunId,
      files: [{ filename: "001.jpg" }],
    }),
  });
  const mobileSignedBody = await mobileSigned.json();
  console.log(`MOBILE_SIGNED_URL_STATUS=${mobileSigned.status}`);
  console.log(
    `MOBILE_SIGNED_URL_OK=${Boolean(mobileSignedBody[0]?.uploadUrl?.startsWith("https://"))}`,
  );
  console.log(
    `MOBILE_TEST_PREFIX_OK=${mobileSignedBody[0]?.key === `_system/mobile-test/${mobileRunId}/001.jpg`}`,
  );
  if (
    !mobileSigned.ok ||
    !mobileSignedBody[0]?.uploadUrl?.startsWith("https://") ||
    mobileSignedBody[0]?.key !== `_system/mobile-test/${mobileRunId}/001.jpg`
  ) {
    throw new Error("モバイルテスト用の署名付きURLを確認できませんでした。");
  }

  const mobileDelete = await fetch(
    `${baseUrl}/api/mobile-test/runs/${encodeURIComponent(mobileRunId)}`,
    {
      method: "DELETE",
      headers: { authorization: `Bearer ${mobileToken}` },
    },
  );
  const mobileDeleteBody = await mobileDelete.json();
  console.log(`MOBILE_DELETE_STATUS=${mobileDelete.status}`);
  console.log(`MOBILE_DELETE_EMPTY=${mobileDeleteBody.deletedCount === 0}`);
  if (!mobileDelete.ok || mobileDeleteBody.deletedCount !== 0) {
    throw new Error("空のモバイルテスト実行を確認できませんでした。");
  }
  console.log("NO_PHOTO_UPLOADED=true");
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
