const STAGING_API_ORIGIN = "https://bjm3jjmvgw2s3ztryzevgvyzx40sztln.lambda-url.ap-northeast-1.on.aws";
const APP_ENVIRONMENTS = new Set(["development", "preview", "production"]);

const normalizedOrigin = (value) => {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
};

module.exports = ({ config }) => {
  const appEnvironment = process.env.EXPO_PUBLIC_APP_ENV;
  const apiUrl = process.env.EXPO_PUBLIC_MOBILE_API_URL;
  if (!APP_ENVIRONMENTS.has(appEnvironment)) {
    throw new Error("EXPO_PUBLIC_APP_ENV must be development, preview, or production.");
  }
  if (!apiUrl || !normalizedOrigin(apiUrl)) {
    throw new Error("EXPO_PUBLIC_MOBILE_API_URL must be a valid URL.");
  }

  const isProduction = appEnvironment === "production";
  const apiOrigin = normalizedOrigin(apiUrl);
  if (appEnvironment === "preview" && apiOrigin !== STAGING_API_ORIGIN) {
    throw new Error("Preview builds may connect only to the isolated mobile staging API.");
  }
  if (isProduction) {
    if (process.env.MOBILE_PRODUCTION_APPROVED !== "true") {
      throw new Error("Production build is locked until MOBILE_PRODUCTION_APPROVED=true is explicitly supplied.");
    }
    if (apiOrigin === STAGING_API_ORIGIN) {
      throw new Error("Production builds may not connect to the mobile staging API.");
    }
    if (!process.env.MOBILE_PRODUCTION_IOS_BUNDLE_ID || !process.env.MOBILE_PRODUCTION_ANDROID_PACKAGE) {
      throw new Error("Production bundle identifiers have not been approved and configured.");
    }
  }

  return {
    ...config,
    name: isProduction ? "TOCORO 清掃写真報告" : "TOCORO 清掃写真報告（検証）",
    ios: {
      ...config.ios,
      bundleIdentifier: isProduction
        ? process.env.MOBILE_PRODUCTION_IOS_BUNDLE_ID
        : "com.tocoro.cleaning.photo-prototype",
    },
    android: {
      ...config.android,
      package: isProduction
        ? process.env.MOBILE_PRODUCTION_ANDROID_PACKAGE
        : "com.tocoro.cleaning.photo_prototype",
    },
    extra: { ...config.extra, appEnvironment },
  };
};
