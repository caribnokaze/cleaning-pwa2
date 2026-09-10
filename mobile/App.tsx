import { StatusBar as ExpoStatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Picker } from "@react-native-picker/picker";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useState } from "react";
import { Modal, Platform, Pressable, SafeAreaView, ScrollView, StatusBar as NativeStatusBar, StyleSheet, Text, TextInput, View } from "react-native";
import { toHiragana, toRomaji } from "wanakana";
import FastPhotoPicker, { PhotoPickerResult, PhotoUploadResult } from "./modules/fast-photo-picker/src";
import GalleryScreen from "./GalleryScreen";

type WorkType = "normal" | "full" | "regular" | "filter";
type Screen = "login" | "details" | "photos" | "review" | "gallery";
type Category = { id: string; label: string; hint?: string; group: "normal" | "regular" | "filter"; min: number; max: number };
type UploadCategory = { id: string; runId: string; assetIds: string[] };
type UploadJob = { version: 1; date: string; site: string; staff: string; workType: WorkType; workTime: string; categories: UploadCategory[]; createdAt: string };
type UploadSummary = { requested: number; uploaded: number; bytes: number; preparationMs: number; uploadMs: number; automaticRetries: number; deleted?: number };
type UploadProgress = { completed: number; total: number };
type AuthSession = { version: 1; token: string; expiresAt: number };
type SelectOption = { value: string; label: string; aliases?: string[] };
type ReportOptions = { staff: SelectOption[]; sites: string[] };

const SITE_SEARCH_ALIASES: Record<string, string[]> = {
  "天庵": ["あまあん"],
  "岩切邸": ["いわきりてい"],
  "金魚": ["きんぎょ"],
  "空間": ["くうま"],
  "湖凪": ["こなぎ"],
  "心": ["こころ"],
  "燦々": ["さんさん"],
  "四季禅": ["しきぜん"],
  "雫": ["しずく"],
  "響": ["ひびき"],
  "富美": ["ふみ"],
  "富士禅": ["ふじぜん"],
  "木座": ["もくざ"],
};
const STAFF_SURNAME_SEARCH_ALIASES: Record<string, string[]> = {
  "今泉": ["いまいずみ"], "天野": ["あまの"], "坂本": ["さかもと"], "山村": ["やまむら"],
  "渡辺": ["わたなべ"], "渡邊": ["わたなべ"], "渡邉": ["わたなべ"], "猪俣": ["いのまた"],
  "宮崎": ["みやざき"], "荒井": ["あらい"], "奥脇": ["おくわき"], "吉沢": ["よしざわ"],
  "希代": ["きたい", "きだい"], "稀代": ["きたい", "きだい"], "高根": ["たかね"], "樫村": ["かしむら"],
  "羽田": ["はねだ", "はだ"], "小林": ["こばやし"], "松本": ["まつもと"], "鈴木": ["すずき"],
  "萱沼": ["かやぬま"], "吉村": ["よしむら"], "桑原": ["くわばら", "くわはら"], "宮本": ["みやもと"],
  "菅谷": ["すがや", "すがたに"], "大森": ["おおもり"], "髙村": ["たかむら"], "廣瀬": ["ひろせ"],
  "鎌田": ["かまた"], "市村": ["いちむら"], "志村": ["しむら"], "栗林": ["くりばやし"],
  "山田": ["やまだ"], "土橋": ["どばし", "つちはし"], "宮下": ["みやした"], "倉沢": ["くらさわ"],
  "中澤": ["なかざわ"], "平井": ["ひらい"], "齊藤": ["さいとう"], "池谷": ["いけたに", "いけや"],
  "堀内": ["ほりうち"], "内田": ["うちだ"], "鷲谷": ["わしや", "わしたに"], "佐久間": ["さくま"],
  "杉本": ["すぎもと"], "大友": ["おおとも"], "小野": ["おの"], "中塚": ["なかつか", "なかづか"],
  "北川": ["きたがわ"], "杉田": ["すぎた"], "安斉": ["あんざい", "あんさい"], "長田": ["おさだ", "ながた"],
  "小俣": ["おまた"], "小佐野": ["こさの"], "長澤": ["ながさわ"], "宇治": ["うじ"],
  "加藤": ["かとう"], "圓谷": ["つぶらや", "つむらや", "えんや"], "井上": ["いのうえ"], "北畑": ["きたはた"],
  "ロサン": ["ろさん"], "大西": ["おおにし"], "清水": ["しみず"], "柴崎": ["しばさき"],
};

const addStaffSurnameAliases = (option: SelectOption): SelectOption => {
  const entry = Object.entries(STAFF_SURNAME_SEARCH_ALIASES)
    .find(([surname]) => option.label.replace(/^\d+\s*/, "").startsWith(surname));
  return entry ? { ...option, aliases: [...(option.aliases ?? []), ...entry[1]] } : option;
};

const APP_ENV = process.env.EXPO_PUBLIC_APP_ENV || "";
const API_URL = (process.env.EXPO_PUBLIC_MOBILE_API_URL || "").replace(/\/$/, "");
const STAGING_API_ORIGIN = "https://bjm3jjmvgw2s3ztryzevgvyzx40sztln.lambda-url.ap-northeast-1.on.aws";
const IS_PRODUCTION = APP_ENV === "production";
const IS_STAGING_BUILD = APP_ENV === "development" || APP_ENV === "preview";
const UPLOAD_JOB_KEY = IS_PRODUCTION ? "tocoro.production-ui.production-upload.v1" : "tocoro.production-ui.staging-upload.v1";
const AUTH_SESSION_KEY = IS_PRODUCTION ? "tocoro.production-ui.production-auth.v1" : "tocoro.production-ui.staging-auth.v1";
const DECLARED_MAX_COMPRESSED_BYTES = 2 * 1024 * 1024;

const buildConfigurationError = () => {
  if (!API_URL || !["development", "preview", "production"].includes(APP_ENV)) {
    return "アプリの接続環境が設定されていません。送信は停止されています。";
  }
  try {
    const origin = new URL(API_URL).origin;
    if (APP_ENV === "preview" && origin !== STAGING_API_ORIGIN) return "検証版の接続先が正しくありません。送信は停止されています。";
    if (IS_PRODUCTION && origin === STAGING_API_ORIGIN) return "本番版から検証環境へは接続できません。";
  } catch {
    return "APIの接続先が正しくありません。送信は停止されています。";
  }
  return "";
};
const BUILD_CONFIGURATION_ERROR = buildConfigurationError();
const formatLoginRetryDelay = (seconds: number) =>
  seconds >= 60 ? `約${Math.ceil(seconds / 60)}分` : "1分未満";

const WORK_TYPES: { id: WorkType; label: string }[] = [
  { id: "normal", label: "通常清掃のみ" },
  { id: "full", label: "定期清掃＋フィルター清掃" },
  { id: "regular", label: "定期清掃のみ" },
  { id: "filter", label: "フィルター清掃のみ" },
];

const CATEGORIES: Category[] = [
  { id: "photos_amenity", label: "タオル・歯ブラシ・Wi-Fi・NetFlix", group: "normal", min: 1, max: 10 },
  { id: "photos_general", label: "その他全般", group: "normal", min: 30, max: 100 },
  { id: "regular_1", label: "リビング・共用スペース（室内）", hint: "ソファの裏・テレビ裏", group: "regular", min: 1, max: 10 },
  { id: "regular_2", label: "寝室まわり", hint: "ベッド下", group: "regular", min: 1, max: 10 },
  { id: "regular_3", label: "キッチン・ダイニング", hint: "皿・トースター・冷蔵庫内", group: "regular", min: 1, max: 10 },
  { id: "regular_4", label: "浴室・洗面・トイレ（水回り）", hint: "排水口・洗濯槽・ドライヤー", group: "regular", min: 1, max: 10 },
  { id: "regular_5", label: "窓・建具", hint: "窓のサン・窓ガラス", group: "regular", min: 1, max: 10 },
  { id: "regular_6", label: "屋外・外周", hint: "施設外周の蜘蛛の巣など", group: "regular", min: 1, max: 10 },
  { id: "regular_7", label: "場所横断", hint: "冊子・棚・電球", group: "regular", min: 1, max: 10 },
  { id: "regular_8", label: "物件指定の清掃箇所・その他", group: "regular", min: 0, max: 10 },
  { id: "photos_filter", label: "フィルター清掃", hint: "エアコン・換気扇・空気清浄機など", group: "filter", min: 1, max: 10 },
];

const localDateString = () => {
  const now = new Date();
  return new Date(now.getTime() - now.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
};
const dateFromLocalString = (value: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return new Date();
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? new Date() : date;
};
const localStringFromDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const includesRegular = (type: WorkType) => type === "regular" || type === "full";
const includesFilter = (type: WorkType) => type === "filter" || type === "full";
const isUploadJob = (value: unknown): value is UploadJob => {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<UploadJob>;
  return job.version === 1 && typeof job.date === "string" && typeof job.site === "string" &&
    typeof job.staff === "string" && WORK_TYPES.some((item) => item.id === job.workType) &&
    typeof job.workTime === "string" && Array.isArray(job.categories) && job.categories.length > 0 &&
    job.categories.every((item) => typeof item?.id === "string" && typeof item.runId === "string" &&
      Array.isArray(item.assetIds) && item.assetIds.length > 0 && item.assetIds.length <= 100 &&
      item.assetIds.every((assetId) => typeof assetId === "string"));
};
const isValidAuthSession = (value: unknown): value is AuthSession => {
  if (!value || typeof value !== "object") return false;
  const session = value as Partial<AuthSession>;
  return session.version === 1 && typeof session.token === "string" && !!session.token &&
    typeof session.expiresAt === "number" && Number.isFinite(session.expiresAt) &&
    session.expiresAt > Math.floor(Date.now() / 1000);
};
const isReportOptions = (value: unknown): value is ReportOptions => {
  if (!value || typeof value !== "object") return false;
  const options = value as Partial<ReportOptions>;
  return Array.isArray(options.staff) && options.staff.length > 0 &&
    options.staff.every((item) => typeof item?.value === "string" && !!item.value && typeof item.label === "string" && !!item.label) &&
    Array.isArray(options.sites) && options.sites.length > 0 && options.sites.every((site) => typeof site === "string" && !!site);
};

export default function App() {
  const [screen, setScreen] = useState<Screen>("login");
  const [cleaningDate, setCleaningDate] = useState(localDateString);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [staffName, setStaffName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [workType, setWorkType] = useState<WorkType>("normal");
  const [workTime, setWorkTime] = useState("");
  const [selections, setSelections] = useState<Record<string, PhotoPickerResult>>({});
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  const [loginRetrySeconds, setLoginRetrySeconds] = useState(0);
  const [isRestoringSession, setIsRestoringSession] = useState(true);
  const [uploadJob, setUploadJob] = useState<UploadJob | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isGalleryBusy, setIsGalleryBusy] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  const [uploadProgress, setUploadProgress] = useState<UploadProgress | null>(null);
  const [completionVisible, setCompletionVisible] = useState(false);
  const [reportOptions, setReportOptions] = useState<ReportOptions | null>(null);
  const [optionsLoading, setOptionsLoading] = useState(false);
  const [optionsReload, setOptionsReload] = useState(0);

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const [storedJob, storedSession] = await Promise.all([
          AsyncStorage.getItem(UPLOAD_JOB_KEY),
          SecureStore.getItemAsync(AUTH_SESSION_KEY),
        ]);
        let restoredJob: UploadJob | null = null;
        if (storedJob) {
          const parsedJob: unknown = JSON.parse(storedJob);
          if (isUploadJob(parsedJob)) {
            restoredJob = parsedJob;
            setUploadJob(parsedJob);
            setCleaningDate(parsedJob.date); setSiteName(parsedJob.site); setStaffName(parsedJob.staff);
            setWorkType(parsedJob.workType); setWorkTime(parsedJob.workTime);
            setSelections(Object.fromEntries(parsedJob.categories.map((item) => [item.id, { assetIds: item.assetIds, dismissalMs: 0 }])));
          } else {
            await AsyncStorage.removeItem(UPLOAD_JOB_KEY);
          }
        }
        let restoredSession: AuthSession | null = null;
        if (storedSession) {
          const parsedSession: unknown = JSON.parse(storedSession);
          if (isValidAuthSession(parsedSession)) {
            restoredSession = parsedSession;
            setAuthToken(parsedSession.token);
          } else {
            await SecureStore.deleteItemAsync(AUTH_SESSION_KEY);
          }
        }
        if (restoredSession) {
          setScreen(restoredJob ? "review" : "details");
          if (restoredJob) setUploadPhase("未完了の送信があります。未完了分だけ再開できます。");
        } else if (restoredJob) {
          setUploadPhase("未完了の送信があります。ログイン後に再開できます。");
        }
      } catch {
        setError("保存したログイン情報または中断した送信情報を読み込めませんでした。");
      } finally {
        setIsRestoringSession(false);
      }
    };
    void restoreSession();
  }, []);

  useEffect(() => {
    if (loginRetrySeconds <= 0) return;
    const timer = setInterval(() => setLoginRetrySeconds((seconds) => {
      if (seconds <= 1) {
        setError("");
        return 0;
      }
      return seconds - 1;
    }), 1_000);
    return () => clearInterval(timer);
  }, [loginRetrySeconds > 0]);

  useEffect(() => {
    if (!authToken || BUILD_CONFIGURATION_ERROR) return;
    let active = true;
    const loadOptions = async () => {
      setOptionsLoading(true);
      try {
        const response = await fetch(`${API_URL}/api/mobile/report-options`, {
          headers: { authorization: `Bearer ${authToken}` },
        });
        const body: unknown = await response.json();
        if (response.status === 401) {
          await clearAuthSession();
          setScreen("login");
          throw new Error("ログインの有効期限が切れました。もう一度ログインしてください。");
        }
        if (!response.ok || !isReportOptions(body)) throw new Error("担当者・現場の選択肢を読み込めませんでした。");
        if (active) {
          setReportOptions(body);
          setError("");
        }
      } catch (optionsError) {
        if (active) {
          setReportOptions(null);
          setError(optionsError instanceof Error ? optionsError.message : String(optionsError));
        }
      } finally {
        if (active) setOptionsLoading(false);
      }
    };
    void loadOptions();
    return () => { active = false; };
  }, [authToken, optionsReload]);

  const visibleCategories = useMemo(() => CATEGORIES.filter((category) =>
    category.group === "normal" ||
    (category.group === "regular" && includesRegular(workType)) ||
    (category.group === "filter" && includesFilter(workType))), [workType]);
  const detailsValid = /^\d{4}-\d{2}-\d{2}$/.test(cleaningDate.trim()) && !!reportOptions &&
    reportOptions.staff.some((item) => item.value === staffName) && reportOptions.sites.includes(siteName);
  const categoryComplete = (category: Category) => {
    const count = selections[category.id]?.assetIds.length ?? 0;
    return count >= category.min && count <= category.max;
  };
  const photosValid = visibleCategories.every(categoryComplete) && (!includesFilter(workType) || !!workTime);
  const totalPhotos = visibleCategories.reduce((total, category) => total + (selections[category.id]?.assetIds.length ?? 0), 0);

  const selectPhotos = async (category: Category) => {
    setError("");
    if ((Platform.OS !== "ios" && Platform.OS !== "android") || !FastPhotoPicker) {
      setError("独自高速ピッカーはiPhone・Android実機で使用してください。");
      return;
    }
    setIsPicking(true);
    try {
      const result = await FastPhotoPicker.pickPhotos(category.max, category.label);
      setSelections((current) => ({ ...current, [category.id]: result }));
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError));
    } finally {
      setIsPicking(false);
    }
  };

  const authenticate = async () => {
    if (BUILD_CONFIGURATION_ERROR) throw new Error(BUILD_CONFIGURATION_ERROR);
    const response = await fetch(`${API_URL}/api/mobile/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    const body = await response.json();
    if (response.status === 429) {
      const retryAfter = Number.parseInt(response.headers.get("retry-after") || "", 10);
      const waitSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 60;
      setLoginRetrySeconds(waitSeconds);
      throw new Error(`ログインが一時的に制限されています。${formatLoginRetryDelay(waitSeconds)}後に再試行してください。`);
    }
    if (!response.ok || !body.token || !Number.isFinite(body.expiresAt)) throw new Error(body.error || "検証環境へログインできませんでした");
    return { version: 1, token: body.token, expiresAt: body.expiresAt } satisfies AuthSession;
  };

  const clearAuthSession = async () => {
    await SecureStore.deleteItemAsync(AUTH_SESSION_KEY);
    setAuthToken("");
  };

  const requireValidSession = (response: Response) => {
    if (response.status !== 401) return;
    setAuthToken("");
    void SecureStore.deleteItemAsync(AUTH_SESSION_KEY).catch(() => undefined);
    setScreen("login");
    throw new Error("ログインの有効期限が切れました。もう一度ログインしてください。");
  };

  const submitLogin = async () => {
    if (!password || isLoggingIn || loginRetrySeconds > 0 || BUILD_CONFIGURATION_ERROR) return;
    setError(""); setIsLoggingIn(true);
    try {
      const session = await authenticate();
      await SecureStore.setItemAsync(AUTH_SESSION_KEY, JSON.stringify(session), {
        keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
      });
      setAuthToken(session.token); setPassword(""); setPasswordVisible(false);
      setScreen(uploadJob ? "review" : "details");
    } catch (loginError) {
      setError(loginError instanceof Error ? loginError.message : String(loginError));
    } finally {
      setPassword(""); setPasswordVisible(false);
      setIsLoggingIn(false);
    }
  };

  const logout = async () => {
    if (isUploading || isDeleting || isLoggingIn) return;
    setError("");
    try {
      await clearAuthSession();
      setPassword(""); setPasswordVisible(false); setScreen("login");
      if (uploadJob) setUploadPhase("未完了の送信があります。ログイン後に再開できます。");
    } catch {
      setError("ログアウト情報を端末から削除できませんでした。");
    }
  };

  const runUpload = async (job: UploadJob, token: string) => {
    if (BUILD_CONFIGURATION_ERROR) throw new Error(BUILD_CONFIGURATION_ERROR);
    if (!FastPhotoPicker) throw new Error("写真送信機能を利用できません。");
    const requested = job.categories.reduce((sum, entry) => sum + entry.assetIds.length, 0);
    let uploaded = 0, bytes = 0, preparationMs = 0, uploadMs = 0, automaticRetries = 0;
    setUploadProgress({ completed: 0, total: requested });
    for (let categoryIndex = 0; categoryIndex < job.categories.length; categoryIndex += 1) {
      const item = job.categories[categoryIndex];
      const category = CATEGORIES.find((candidate) => candidate.id === item.id);
      const files = item.assetIds.map((_, index) => ({
        clientPhotoId: `photo-${String(index + 1).padStart(4, "0")}`,
        contentType: "image/jpeg",
        size: DECLARED_MAX_COMPRESSED_BYTES,
      }));
      setUploadPhase(`${categoryIndex + 1}/${job.categories.length} ${category?.label || item.id}：保存済み写真を確認中…`);
      const beforeResponse = await fetch(`${API_URL}/api/mobile/uploads/${item.runId}`, { headers: { authorization: `Bearer ${token}` } });
      requireValidSession(beforeResponse);
      const beforeBody = await beforeResponse.json();
      if (!beforeResponse.ok) throw new Error(beforeBody.error || "保存済み写真を確認できませんでした");
      const stored = new Set<string>(beforeBody.confirmed || []);
      const missing = files.map((file, index) => stored.has(file.clientPhotoId) ? -1 : index).filter((index) => index >= 0);
      const alreadyUploadedInCategory = files.length - missing.length;
      setUploadProgress({ completed: uploaded + alreadyUploadedInCategory, total: requested });
      if (missing.length) {
        setUploadPhase(`${categoryIndex + 1}/${job.categories.length} ${category?.label || item.id}：${missing.length}枚を準備・送信中…`);
        const signedResponse = await fetch(`${API_URL}/api/mobile/photos/presigned-urls`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({
            uploadId: item.runId,
            date: job.date,
            site: job.site,
            staff: job.staff,
            photoId: item.id,
            filterMinutes: item.id === "photos_filter" ? Number(job.workTime) : undefined,
            files: missing.map((index) => files[index]),
          }),
        });
        requireValidSession(signedResponse);
        const signedBody = await signedResponse.json();
        if (!signedResponse.ok || !Array.isArray(signedBody.files)) throw new Error(signedBody.error || "送信URLを取得できませんでした");
        const targetById = new Map<string, string>(signedBody.files.map((target: { clientPhotoId: string; uploadUrl: string }) => [target.clientPhotoId, target.uploadUrl]));
        const uploadUrls = missing.map((index) => targetById.get(files[index].clientPhotoId) || "");
        if (uploadUrls.some((uploadUrl) => !uploadUrl)) throw new Error("写真と送信URLを対応付けできませんでした");
        const progressSubscription = FastPhotoPicker.addListener("onUploadProgress", ({ completedCount }) => {
          setUploadProgress({
            completed: uploaded + alreadyUploadedInCategory + completedCount,
            total: requested,
          });
        });
        let nativeResult: PhotoUploadResult;
        try {
          nativeResult = await FastPhotoPicker.prepareAndUploadPhotos(
            missing.map((index) => item.assetIds[index]), uploadUrls, 720, 0.45, "none",
          );
        } finally {
          progressSubscription.remove();
        }
        preparationMs += nativeResult.preparationMs; uploadMs += nativeResult.uploadMs;
        automaticRetries += nativeResult.automaticRetryCount;
      }
      const confirmResponse = await fetch(`${API_URL}/api/mobile/photos/confirm`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ uploadId: item.runId, photos: files.map(({ clientPhotoId }) => ({ clientPhotoId })) }),
      });
      requireValidSession(confirmResponse);
      const confirmed = await confirmResponse.json();
      if (!confirmResponse.ok || confirmed.missing?.length || confirmed.confirmed?.length !== item.assetIds.length) {
        throw new Error(`${category?.label || item.id}：${confirmed.missing?.length ?? item.assetIds.length}枚が未送信です`);
      }
      const verifyResponse = await fetch(`${API_URL}/api/mobile/uploads/${item.runId}`, { headers: { authorization: `Bearer ${token}` } });
      requireValidSession(verifyResponse);
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok || verified.confirmed?.length !== item.assetIds.length) {
        throw new Error(`${category?.label || item.id}：${item.assetIds.length - (verified.confirmed?.length || 0)}枚が未送信です`);
      }
      uploaded += verified.confirmed.length; bytes += verified.totalBytes || 0;
      setUploadProgress({ completed: uploaded, total: requested });
      setUploadSummary({ requested, uploaded, bytes, preparationMs, uploadMs, automaticRetries });
    }
    if (IS_STAGING_BUILD) {
      setUploadPhase("全カテゴリーの検証S3保存を確認しました。確認後に削除してください。");
    } else {
      await AsyncStorage.removeItem(UPLOAD_JOB_KEY); setUploadJob(null);
      setUploadPhase("全カテゴリーの送信が完了しました。");
      setCompletionVisible(true);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      setSiteName("");
      setWorkType("normal");
      setWorkTime("");
      setSelections({});
      setUploadSummary(null);
      setUploadProgress(null);
      setUploadPhase("");
      setError("");
      setScreen("details");
      setCompletionVisible(false);
    }
  };

  const startUpload = async () => {
    if (!authToken || isUploading || !FastPhotoPicker) return;
    const stamp = Date.now();
    const categories = visibleCategories.filter((category) => (selections[category.id]?.assetIds.length ?? 0) > 0).map((category) => ({
      id: category.id, runId: `${Platform.OS}-${stamp}-${category.id}`.slice(0, 64), assetIds: selections[category.id].assetIds,
    }));
    const job: UploadJob = { version: 1, date: cleaningDate.trim(), site: siteName.trim(), staff: staffName.trim(), workType, workTime, categories, createdAt: new Date().toISOString() };
    setError(""); setUploadSummary(null); setUploadProgress(null); setIsUploading(true); setUploadJob(job);
    try { await AsyncStorage.setItem(UPLOAD_JOB_KEY, JSON.stringify(job)); await runUpload(job, authToken); }
    catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); setUploadPhase("送信を中断しました。未完了分だけ再開できます。"); }
    finally { setIsUploading(false); }
  };

  const resumeUpload = async () => {
    if (!uploadJob || !authToken || isUploading) return;
    setError(""); setUploadProgress(null); setIsUploading(true);
    try { await runUpload(uploadJob, authToken); }
    catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); setUploadPhase("再開を中断しました。もう一度再開できます。"); }
    finally { setIsUploading(false); }
  };

  const deleteUpload = async () => {
    if (!IS_STAGING_BUILD || !uploadJob || !authToken || isDeleting) return;
    setError(""); setIsDeleting(true); setUploadPhase("検証S3から写真を削除中…");
    try {
      let deleted = 0;
      for (const item of uploadJob.categories) {
        const response = await fetch(`${API_URL}/api/mobile-test/production-contract/${item.runId}`, { method: "DELETE", headers: { authorization: `Bearer ${authToken}` } });
        requireValidSession(response);
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "検証写真を削除できませんでした");
        deleted += body.deletedCount || 0;
      }
      setUploadSummary((current) => current ? { ...current, deleted } : current);
      await AsyncStorage.removeItem(UPLOAD_JOB_KEY); setUploadJob(null);
      setUploadPhase(`検証S3から削除：${deleted}枚`);
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : String(deleteError)); setUploadPhase("削除できませんでした。再ログインして再開してください。"); }
    finally { setIsDeleting(false); }
  };

  return (
    <SafeAreaView style={[styles.safeArea, Platform.OS === "android" && styles.androidSafeArea]}>
      <ExpoStatusBar style="dark" />
      <View style={styles.header}><Text style={styles.brand}>TOCORO.</Text><Text style={styles.headerTitle}>清掃写真報告</Text>{IS_STAGING_BUILD && <View style={styles.headerEnvironmentBadge}><Text style={styles.headerEnvironmentText}>検証環境</Text></View>}{screen !== "login" && <Pressable style={[styles.galleryNavButton, isGalleryBusy && styles.buttonDisabled]} onPress={() => setScreen(screen === "gallery" ? (uploadJob ? "review" : "details") : "gallery")} disabled={isUploading || isDeleting || isGalleryBusy}><Text style={styles.galleryNavText}>{screen === "gallery" ? "報告入力" : "写真一覧"}</Text></Pressable>}{screen !== "login" && <Pressable style={[styles.logoutButton, isGalleryBusy && styles.buttonDisabled]} onPress={logout} disabled={isUploading || isDeleting || isGalleryBusy}><Text style={styles.logoutText}>ログアウト</Text></Pressable>}</View>
      {screen !== "login" && screen !== "gallery" && <View style={styles.steps}>
        {(["details", "photos", "review"] as Screen[]).map((step, index) => (
          <View key={step} style={styles.stepItem}>
            <View style={[styles.stepCircle, screen === step && styles.stepCircleActive]}><Text style={[styles.stepNumber, screen === step && styles.stepNumberActive]}>{index + 1}</Text></View>
            <Text style={[styles.stepLabel, screen === step && styles.stepLabelActive]}>{index === 0 ? "報告情報" : index === 1 ? "写真" : "確認"}</Text>
          </View>
        ))}
      </View>}
      {screen === "gallery" ? <GalleryScreen apiUrl={API_URL} authToken={authToken} onSessionExpired={() => { void clearAuthSession(); setScreen("login"); }} onBusyChange={setIsGalleryBusy} /> : <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {screen === "login" && <>
          <Text style={styles.title}>ログイン</Text>
          <Text style={styles.description}>清掃写真報告を始めるため、共通パスワードを入力してください。パスワードは端末へ保存しません。</Text>
          {!!uploadJob && <View style={styles.notice}><Text style={styles.noticeTitle}>未完了の送信があります</Text><Text style={styles.noticeText}>ログイン後、確認画面から未完了分だけ再開できます。</Text></View>}
          <TextInput style={styles.passwordInput} value={password} onChangeText={setPassword} placeholder={IS_PRODUCTION ? "パスワード" : "検証環境のパスワード"} secureTextEntry={!passwordVisible} autoCapitalize="none" autoCorrect={false} editable={!isLoggingIn} onSubmitEditing={submitLogin} />
          {IS_PRODUCTION && <View style={styles.passwordHelp}><Pressable onPress={() => setPasswordVisible((visible) => !visible)} disabled={isLoggingIn}><Text style={styles.passwordToggle}>{passwordVisible ? "隠す" : "表示する"}</Text></Pressable></View>}
          {!!BUILD_CONFIGURATION_ERROR && <Text style={styles.error}>{BUILD_CONFIGURATION_ERROR}</Text>}
          <PrimaryButton label={isRestoringSession ? "ログイン状態を確認中…" : isLoggingIn ? "ログイン中…" : loginRetrySeconds > 0 ? `再試行まで ${formatLoginRetryDelay(loginRetrySeconds)}` : "ログイン"} onPress={submitLogin} disabled={!password || isLoggingIn || isRestoringSession || loginRetrySeconds > 0 || !!BUILD_CONFIGURATION_ERROR} />
        </>}

        {screen === "details" && <>
          <Text style={styles.title}>報告情報を入力</Text>
          <Text style={styles.description}>現在のWeb版と同じ情報を入力します。</Text>
          <Field label="清掃日">
            <Pressable
              style={styles.dateInput}
              onPress={() => setDatePickerVisible(true)}
              accessibilityRole="button"
              accessibilityLabel={`清掃日 ${cleaningDate}`}
              accessibilityHint="日付選択を開きます"
            >
              <Text style={styles.dateInputText}>{cleaningDate}</Text>
              <Text style={styles.dateInputIcon}>📅</Text>
            </Pressable>
            {datePickerVisible && <View style={Platform.OS === "ios" ? styles.iosDatePicker : undefined}>
              <DateTimePicker
                value={dateFromLocalString(cleaningDate)}
                mode="date"
                display={Platform.OS === "ios" ? "spinner" : "default"}
                locale="ja-JP"
                onChange={(event: DateTimePickerEvent, date?: Date) => {
                  if (Platform.OS === "android") setDatePickerVisible(false);
                  if (event.type === "set" && date) setCleaningDate(localStringFromDate(date));
                }}
              />
              {Platform.OS === "ios" && <Pressable style={styles.datePickerClose} onPress={() => setDatePickerVisible(false)}>
                <Text style={styles.datePickerCloseText}>閉じる</Text>
              </Pressable>}
            </View>}
          </Field>
          <Field label="担当者"><SearchableSelect value={staffName} options={(reportOptions?.staff ?? []).map(addStaffSurnameAliases)} onSelect={setStaffName} placeholder="番号・氏名・読み仮名で検索" selectionLabel="担当者" loading={optionsLoading} /></Field>
          <Field label="現場"><SearchableSelect value={siteName} options={(reportOptions?.sites ?? []).map((site) => ({ value: site, label: site, aliases: SITE_SEARCH_ALIASES[site] }))} onSelect={setSiteName} placeholder="現場名を入力して検索" selectionLabel="物件名" loading={optionsLoading} /></Field>
          {!reportOptions && !optionsLoading && <SecondaryButton label="選択肢を再読み込み" onPress={() => setOptionsReload((value) => value + 1)} />}
          <Text style={styles.sectionLabel}>作業区分 <Text style={styles.required}>必須</Text></Text>
          {WORK_TYPES.map((item) => {
            const selected = item.id === workType;
            return <Pressable key={item.id} style={[styles.choice, selected && styles.choiceSelected]} onPress={() => { setWorkType(item.id); setError(""); }} accessibilityRole="radio" accessibilityState={{ checked: selected }}>
              <View style={[styles.radio, selected && styles.radioSelected]} /><Text style={[styles.choiceText, selected && styles.choiceTextSelected]}>{item.label}</Text>
            </Pressable>;
          })}
          <PrimaryButton label="写真カテゴリーへ" onPress={() => setScreen("photos")} disabled={!detailsValid} />
        </>}

        {screen === "photos" && <>
          <Text style={[styles.title, styles.photoSelectionTitle]}>カテゴリーごとに写真を選択</Text>
          <View style={styles.summaryCard}><Text style={styles.summaryText}>{cleaningDate}　{siteName}</Text><Text style={styles.summarySub}>{staffName}　／　{WORK_TYPES.find((item) => item.id === workType)?.label}</Text></View>
          {(["normal", "regular", "filter"] as const).map((group) => {
            const groupCategories = visibleCategories.filter((category) => category.group === group);
            if (!groupCategories.length) return null;
            return <View key={group} style={styles.categoryGroup}>
              <Text style={styles.groupTitle}>{group === "normal" ? "通常清掃" : group === "regular" ? "定期清掃" : "フィルター清掃"}</Text>
              {groupCategories.map((category) => {
                const count = selections[category.id]?.assetIds.length ?? 0;
                const complete = categoryComplete(category);
                return <Pressable key={category.id} style={styles.categoryRow} onPress={() => selectPhotos(category)} disabled={isPicking}>
                  <View style={styles.categoryContent}><View style={styles.categoryTitleRow}><Text style={styles.categoryTitle}>{category.label}</Text>{category.min > 0 && <Text style={styles.requiredBadge}>必須</Text>}</View>
                    {!!category.hint && <Text style={styles.categoryHint}>{category.hint}</Text>}<Text style={styles.limitText}>{category.min > 0 ? `${category.min}〜${category.max}枚` : `任意・最大${category.max}枚`}</Text></View>
                  <View style={[styles.countPill, complete && styles.countPillComplete]}><Text style={[styles.countText, complete && styles.countTextComplete]}>{count}/{category.max}</Text></View>
                </Pressable>;
              })}
            </View>;
          })}
          {includesFilter(workType) && <View style={styles.categoryGroup}><Text style={styles.groupTitle}>フィルター清掃時間 <Text style={styles.required}>必須</Text></Text><View style={styles.timeGrid}>
            {[15, 30, 45, 60, 75, 90, 105, 120].map((minutes) => <Pressable key={minutes} style={[styles.timeButton, workTime === String(minutes) && styles.timeButtonSelected]} onPress={() => setWorkTime(String(minutes))}><Text style={[styles.timeText, workTime === String(minutes) && styles.timeTextSelected]}>{minutes}分</Text></Pressable>)}
          </View></View>}
          <Text style={styles.total}>合計 {totalPhotos}枚</Text>
          <View style={styles.navigationRow}><SecondaryButton label="戻る" onPress={() => setScreen("details")} /><PrimaryButton label="内容を確認" onPress={() => setScreen("review")} disabled={!photosValid} compact /></View>
        </>}

        {screen === "review" && <>
          <Text style={styles.title}>送信内容を確認</Text>
          <View style={styles.reviewCard}><ReviewLine label="清掃日" value={cleaningDate} /><ReviewLine label="担当者" value={staffName} /><ReviewLine label="現場" value={siteName} /><ReviewLine label="作業区分" value={WORK_TYPES.find((item) => item.id === workType)?.label ?? ""} />{includesFilter(workType) && <ReviewLine label="作業時間" value={`${workTime}分`} />}</View>
          <View style={styles.reviewCard}><Text style={styles.groupTitle}>カテゴリー別枚数</Text>{visibleCategories.map((category) => <ReviewLine key={category.id} label={category.label} value={`${selections[category.id]?.assetIds.length ?? 0}枚`} />)}<View style={styles.totalDivider} /><ReviewLine label="合計" value={`${totalPhotos}枚`} strong /></View>
          {IS_STAGING_BUILD && <View style={styles.notice}><Text style={styles.noticeTitle}>検証専用S3への送信です</Text><Text style={styles.noticeText}>本番には送信しません。確認後は、この画面からテスト写真を削除してください。</Text></View>}
          {!!uploadPhase && <Text style={styles.phase}>{uploadPhase}</Text>}
          {uploadProgress && <View style={styles.progressCard} accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: uploadProgress.total, now: uploadProgress.completed }}>
            <View style={styles.progressHeader}><Text style={styles.progressLabel}>{uploadProgress.completed >= uploadProgress.total ? "送信完了" : "写真を送信中"}</Text><Text style={styles.progressCount}>{uploadProgress.completed}/{uploadProgress.total}枚</Text></View>
            <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${uploadProgress.total > 0 ? Math.min(100, Math.round((uploadProgress.completed / uploadProgress.total) * 100)) : 0}%` }]} /></View>
          </View>}
          {uploadSummary && <View style={styles.uploadResult}>
            <Text style={styles.groupTitle}>{IS_STAGING_BUILD ? "検証S3送信結果" : "送信結果"}</Text>
            <ReviewLine label="成功" value={`${uploadSummary.uploaded}/${uploadSummary.requested}枚`} />
            {IS_STAGING_BUILD && <>
              <ReviewLine label="準備時間" value={`${uploadSummary.preparationMs}ms`} />
              <ReviewLine label="送信時間" value={`${uploadSummary.uploadMs}ms`} />
              <ReviewLine label="送信容量" value={`${(uploadSummary.bytes / 1024 / 1024).toFixed(1)}MB`} />
              <ReviewLine label="自動再試行" value={`${uploadSummary.automaticRetries}回`} />
              {uploadSummary.deleted !== undefined && <ReviewLine label="検証S3から削除" value={`${uploadSummary.deleted}枚`} strong />}
            </>}
          </View>}
          <View style={styles.navigationRow}>
            {!uploadJob && <SecondaryButton label="写真を修正" onPress={() => setScreen("photos")} />}
            <PrimaryButton label={isUploading ? "送信中…" : uploadJob ? "未完了の送信を再開" : IS_STAGING_BUILD ? "検証S3へ送信" : "写真を送信"} onPress={uploadJob ? resumeUpload : startUpload} disabled={!authToken || isUploading || isDeleting || (!!uploadSummary && uploadSummary.uploaded === uploadSummary.requested)} compact />
          </View>
          {IS_STAGING_BUILD && !!uploadJob && !!authToken && uploadSummary?.uploaded === uploadSummary?.requested && <Pressable style={[styles.deleteButton, isDeleting && styles.buttonDisabled]} onPress={deleteUpload} disabled={isDeleting}><Text style={styles.primaryButtonText}>{isDeleting ? "削除中…" : "確認済みのテスト写真を削除"}</Text></Pressable>}
        </>}
        {!!error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>}
      <Modal visible={completionVisible} transparent animationType="fade" statusBarTranslucent>
        <View style={styles.completionOverlay} accessibilityRole="alert">
          <View style={styles.completionCard}>
            <Text style={styles.completionIcon}>✓</Text>
            <Text style={styles.completionText}>お疲れ様でした！</Text>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.sectionLabel}>{label} <Text style={styles.required}>必須</Text></Text>{children}</View>;
}
const SEARCH_CHARACTER_EQUIVALENTS: Record<string, string> = {
  "邊": "辺", "邉": "辺",
  "斉": "斎", "齋": "斎", "齊": "斎",
  "髙": "高", "﨑": "崎", "嶋": "島",
  "澤": "沢", "濱": "浜", "廣": "広",
  "國": "国", "櫻": "桜", "德": "徳",
  "瀨": "瀬", "眞": "真", "惠": "恵",
  "榮": "栄", "禮": "礼", "萬": "万",
  "壽": "寿", "冨": "富", "𠮷": "吉",
};
function normalizeSearch(value: string) {
  return value
    .normalize("NFKC")
    .toLocaleLowerCase("ja")
    .replace(/[邊邉斉齋齊髙﨑嶋澤濱廣國櫻德瀨眞惠榮禮萬壽冨𠮷]/gu, (character) => SEARCH_CHARACTER_EQUIVALENTS[character] ?? character)
    .replace(/[\s・._-]+/g, "");
}
function searchForms(value: string) {
  const forms = [value, toHiragana(value), toRomaji(value)]
    .map(normalizeSearch)
    .filter(Boolean);
  return [...new Set(forms)];
}
function matchesSearch(candidate: string, query: string) {
  const queryForms = searchForms(query);
  const candidateForms = searchForms(candidate);
  return queryForms.some((queryForm) => candidateForms.some((candidateForm) => candidateForm.includes(queryForm)));
}
function SearchableSelect({ value, options, onSelect, placeholder, selectionLabel, loading }: { value: string; options: SelectOption[]; onSelect: (value: string) => void; placeholder: string; selectionLabel: string; loading: boolean }) {
  const selected = options.find((item) => item.value === value);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [pickerVisible, setPickerVisible] = useState(false);
  const [pickerValue, setPickerValue] = useState("");
  useEffect(() => {
    if (value) setQuery(selected?.label ?? value);
  }, [value, selected?.label]);
  const normalized = normalizeSearch(query);
  const matches = options.filter((item) => !normalized || [item.label, item.value, ...(item.aliases ?? [])].some((candidate) => matchesSearch(candidate, query)));
  const visible = normalized ? matches : [];
  return <View>
    <View style={styles.selectInputRow}>
      <TextInput
        style={[styles.input, styles.selectSearchInput]}
        value={query}
        onFocus={() => setOpen(false)}
        onChangeText={(text) => { setQuery(text); onSelect(""); setOpen(!!normalizeSearch(text)); }}
        placeholder={loading ? "選択肢を読み込み中…" : placeholder}
        editable={!loading}
        autoCorrect={false}
        accessibilityRole="search"
      />
      <Pressable
        style={[styles.selectPickerButton, (loading || !options.length) && styles.buttonDisabled]}
        onPress={() => {
          setPickerValue(value || options[0]?.value || "");
          setOpen(false);
          setPickerVisible(true);
        }}
        disabled={loading || !options.length}
        accessibilityRole="button"
        accessibilityLabel={`${selectionLabel}を一覧から選択`}
      ><Text style={styles.selectPickerButtonText}>⌄</Text></Pressable>
    </View>
    {open && !loading && <View style={styles.selectOptions}>
      {visible.map((item) => <Pressable key={item.value} style={[styles.selectOption, item.value === value && styles.selectOptionSelected]} onPress={() => { onSelect(item.value); setQuery(item.label); setOpen(false); }} accessibilityRole="button">
        <Text style={[styles.selectOptionText, item.value === value && styles.selectOptionTextSelected]}>{item.label}</Text>
      </Pressable>)}
      {!visible.length && <Text style={styles.selectEmpty}>一致する選択肢がありません</Text>}
    </View>}
    <Modal visible={pickerVisible} transparent animationType="slide" onRequestClose={() => setPickerVisible(false)}>
      <View style={styles.pickerOverlay}>
        <View style={styles.pickerSheet}>
          <Text style={styles.pickerTitle}>{selectionLabel}を選択</Text>
          <Picker selectedValue={pickerValue} onValueChange={(nextValue) => setPickerValue(String(nextValue))} mode={Platform.OS === "android" ? "dropdown" : undefined}>
            {options.map((item) => <Picker.Item key={item.value} label={item.label} value={item.value} />)}
          </Picker>
          <View style={styles.pickerActions}>
            <Pressable style={styles.pickerCancelButton} onPress={() => setPickerVisible(false)}><Text style={styles.pickerCancelText}>キャンセル</Text></Pressable>
            <Pressable style={styles.pickerConfirmButton} onPress={() => {
              const item = options.find((option) => option.value === pickerValue);
              if (item) { onSelect(item.value); setQuery(item.label); }
              setPickerVisible(false);
            }}><Text style={styles.pickerConfirmText}>選択</Text></Pressable>
          </View>
        </View>
      </View>
    </Modal>
  </View>;
}
function PrimaryButton({ label, onPress, disabled, compact }: { label: string; onPress: () => void; disabled?: boolean; compact?: boolean }) {
  return <Pressable style={[styles.primaryButton, compact && styles.compactButton, disabled && styles.buttonDisabled]} onPress={onPress} disabled={disabled}><Text style={styles.primaryButtonText}>{label}</Text></Pressable>;
}
function SecondaryButton({ label, onPress }: { label: string; onPress: () => void }) {
  return <Pressable style={styles.secondaryButton} onPress={onPress}><Text style={styles.secondaryButtonText}>{label}</Text></Pressable>;
}
function ReviewLine({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return <View style={styles.reviewLine}><Text style={[styles.reviewLabel, strong && styles.strong]}>{label}</Text><Text style={[styles.reviewValue, strong && styles.strong]}>{value}</Text></View>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f5f7f6" },
  androidSafeArea: { paddingTop: NativeStatusBar.currentHeight ?? 0 },
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#dce4e1" },
  brand: { fontSize: 23, fontWeight: "900", color: "#12634f", marginRight: 10 },
  headerTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: "#36564e" },
  headerEnvironmentBadge: { marginRight: 8, paddingHorizontal: 7, paddingVertical: 4, borderRadius: 9, backgroundColor: "#fff0c2" },
  headerEnvironmentText: { color: "#765200", fontSize: 10, fontWeight: "900" },
  logoutButton: { paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, borderWidth: 1, borderColor: "#9db0aa" },
  logoutText: { color: "#36564e", fontSize: 12, fontWeight: "800" },
  galleryNavButton: { marginRight: 7, paddingVertical: 7, paddingHorizontal: 9, borderRadius: 8, backgroundColor: "#16745e" },
  galleryNavText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  steps: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 12, backgroundColor: "#fff" },
  stepItem: { flexDirection: "row", alignItems: "center" },
  stepCircle: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#e4ebe8", marginRight: 6 },
  stepCircleActive: { backgroundColor: "#16745e" }, stepNumber: { fontSize: 12, fontWeight: "800", color: "#60706c" }, stepNumberActive: { color: "#fff" }, stepLabel: { fontSize: 12, color: "#788781" }, stepLabelActive: { color: "#16745e", fontWeight: "800" },
  container: { padding: 20, paddingBottom: 48 }, title: { fontSize: 24, fontWeight: "900", color: "#173c33", marginTop: 4 }, description: { fontSize: 14, lineHeight: 21, color: "#60706c", marginTop: 8, marginBottom: 20 },
  photoSelectionTitle: { marginBottom: 20 },
  field: { marginBottom: 17 }, sectionLabel: { color: "#294b42", fontSize: 15, fontWeight: "800", marginBottom: 8 }, required: { color: "#b42318", fontSize: 11 },
  input: { borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, backgroundColor: "#fff" },
  selectInputRow: { flexDirection: "row", alignItems: "stretch", gap: 7 },
  selectSearchInput: { flex: 1 },
  selectPickerButton: { width: 50, borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, backgroundColor: "#fff", alignItems: "center", justifyContent: "center" },
  selectPickerButtonText: { color: "#16745e", fontSize: 25, fontWeight: "800", marginTop: -5, transform: [{ translateY: -3 }] },
  pickerOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" },
  pickerSheet: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 28 },
  pickerTitle: { color: "#173c33", fontSize: 18, fontWeight: "900", textAlign: "center", marginBottom: 4 },
  pickerActions: { flexDirection: "row", gap: 10, marginTop: 8 },
  pickerCancelButton: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: "#16745e", borderRadius: 10, alignItems: "center", justifyContent: "center" },
  pickerCancelText: { color: "#16745e", fontSize: 15, fontWeight: "800" },
  pickerConfirmButton: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: "#16745e", alignItems: "center", justifyContent: "center" },
  pickerConfirmText: { color: "#fff", fontSize: 15, fontWeight: "800" },
  dateInput: { minHeight: 50, borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, backgroundColor: "#fff", flexDirection: "row", alignItems: "center" },
  dateInputText: { flex: 1, color: "#1f312c", fontSize: 16 },
  dateInputIcon: { fontSize: 18 },
  iosDatePicker: { marginTop: 8, borderWidth: 1, borderColor: "#d6dfdc", borderRadius: 10, backgroundColor: "#fff", overflow: "hidden" },
  datePickerClose: { alignSelf: "flex-end", paddingHorizontal: 18, paddingVertical: 12 },
  datePickerCloseText: { color: "#16745e", fontSize: 15, fontWeight: "800" },
  selectOptions: { marginTop: 5, borderWidth: 1, borderColor: "#c8d2ce", borderRadius: 10, overflow: "hidden", backgroundColor: "#fff" },
  selectOption: { minHeight: 45, justifyContent: "center", paddingHorizontal: 14, paddingVertical: 10, borderBottomWidth: 1, borderBottomColor: "#e7ecea" },
  selectOptionSelected: { backgroundColor: "#eaf5f1" },
  selectOptionText: { color: "#344640", fontSize: 15 },
  selectOptionTextSelected: { color: "#12634f", fontWeight: "800" },
  selectEmpty: { padding: 14, color: "#6a7974", fontSize: 14 },
  choice: { flexDirection: "row", alignItems: "center", padding: 14, borderRadius: 10, borderWidth: 1, borderColor: "#c8d2ce", backgroundColor: "#fff", marginBottom: 9 }, choiceSelected: { borderColor: "#16745e", backgroundColor: "#eaf5f1" },
  radio: { width: 19, height: 19, borderRadius: 10, borderWidth: 2, borderColor: "#8b9994", marginRight: 11 }, radioSelected: { borderWidth: 6, borderColor: "#16745e", backgroundColor: "#fff" }, choiceText: { fontSize: 15, color: "#344640" }, choiceTextSelected: { color: "#12634f", fontWeight: "800" },
  primaryButton: { marginTop: 14, minHeight: 52, borderRadius: 12, backgroundColor: "#16745e", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 }, compactButton: { flex: 1, marginTop: 0 }, primaryButtonText: { color: "#fff", fontSize: 16, fontWeight: "800" }, buttonDisabled: { opacity: 0.35 },
  summaryCard: { backgroundColor: "#eaf5f1", borderRadius: 10, padding: 13, marginBottom: 18 }, summaryText: { color: "#173c33", fontSize: 15, fontWeight: "800" }, summarySub: { color: "#49655d", fontSize: 13, marginTop: 5 },
  categoryGroup: { marginBottom: 20 }, groupTitle: { fontSize: 18, color: "#173c33", fontWeight: "900", marginBottom: 10 }, categoryRow: { minHeight: 82, flexDirection: "row", alignItems: "center", backgroundColor: "#fff", borderWidth: 1, borderColor: "#d6dfdc", borderRadius: 12, padding: 14, marginBottom: 9 },
  categoryContent: { flex: 1, paddingRight: 10 }, categoryTitleRow: { flexDirection: "row", alignItems: "center", flexWrap: "wrap" }, categoryTitle: { fontSize: 15, lineHeight: 21, fontWeight: "800", color: "#253d37" }, requiredBadge: { marginLeft: 7, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, overflow: "hidden", backgroundColor: "#fce8e6", color: "#b42318", fontSize: 10, fontWeight: "800" },
  categoryHint: { marginTop: 4, color: "#6a7974", fontSize: 12, lineHeight: 17 }, limitText: { marginTop: 5, color: "#60706c", fontSize: 12 }, countPill: { minWidth: 56, paddingVertical: 9, paddingHorizontal: 8, alignItems: "center", borderRadius: 18, backgroundColor: "#eef2f1" }, countPillComplete: { backgroundColor: "#d9f1e8" }, countText: { color: "#687771", fontSize: 13, fontWeight: "800" }, countTextComplete: { color: "#12634f" },
  timeGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 }, timeButton: { width: "23%", borderWidth: 1, borderColor: "#b8c5c0", borderRadius: 9, backgroundColor: "#fff", paddingVertical: 11, alignItems: "center" }, timeButtonSelected: { borderColor: "#16745e", backgroundColor: "#16745e" }, timeText: { color: "#36564e", fontWeight: "700" }, timeTextSelected: { color: "#fff" },
  total: { textAlign: "right", color: "#173c33", fontSize: 17, fontWeight: "900", marginBottom: 14 }, navigationRow: { flexDirection: "row", gap: 10, marginTop: 8 }, secondaryButton: { minWidth: 98, minHeight: 52, borderRadius: 12, borderWidth: 1, borderColor: "#16745e", alignItems: "center", justifyContent: "center", backgroundColor: "#fff", paddingHorizontal: 16 }, secondaryButtonText: { color: "#16745e", fontSize: 16, fontWeight: "800" },
  reviewCard: { marginTop: 16, padding: 16, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#d6dfdc" }, reviewLine: { flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start", gap: 14, paddingVertical: 7 }, reviewLabel: { flex: 1, color: "#60706c", fontSize: 14 }, reviewValue: { flex: 1, textAlign: "right", color: "#1f312c", fontSize: 14 }, strong: { color: "#173c33", fontSize: 17, fontWeight: "900" }, totalDivider: { borderTopWidth: 1, borderTopColor: "#dce4e1", marginTop: 8 },
  notice: { marginTop: 16, padding: 14, borderRadius: 10, backgroundColor: "#fff6df", borderWidth: 1, borderColor: "#ecd49a" }, noticeTitle: { color: "#765200", fontWeight: "900", marginBottom: 5 }, noticeText: { color: "#765f25", fontSize: 13, lineHeight: 19 },
  passwordInput: { marginTop: 16, borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, backgroundColor: "#fff" },
  passwordHelp: { marginTop: 8, flexDirection: "row", justifyContent: "flex-end" },
  passwordToggle: { color: "#16745e", fontSize: 14, fontWeight: "800", paddingVertical: 4, paddingHorizontal: 6 },
  phase: { marginTop: 13, color: "#36564e", fontSize: 14, lineHeight: 20, textAlign: "center" },
  progressCard: { marginTop: 12, padding: 14, borderRadius: 10, backgroundColor: "#eaf5f1", borderWidth: 1, borderColor: "#bcd8cf" },
  progressHeader: { flexDirection: "row", justifyContent: "space-between", alignItems: "center", marginBottom: 9 },
  progressLabel: { color: "#173c33", fontSize: 14, fontWeight: "800" },
  progressCount: { color: "#12634f", fontSize: 14, fontWeight: "900" },
  progressTrack: { height: 10, borderRadius: 5, overflow: "hidden", backgroundColor: "#cbd9d4" },
  progressFill: { height: "100%", borderRadius: 5, backgroundColor: "#16745e" },
  uploadResult: { marginTop: 16, padding: 16, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#bcd8cf" },
  deleteButton: { marginTop: 12, minHeight: 52, borderRadius: 12, backgroundColor: "#9b2c2c", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  error: { marginTop: 18, color: "#b42318", fontSize: 14, lineHeight: 20 },
  completionOverlay: { flex: 1, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(19, 49, 41, 0.5)", padding: 24 },
  completionCard: { width: "100%", maxWidth: 340, paddingVertical: 38, paddingHorizontal: 24, borderRadius: 18, alignItems: "center", backgroundColor: "#fff" },
  completionIcon: { width: 58, height: 58, paddingTop: 10, borderRadius: 29, overflow: "hidden", textAlign: "center", backgroundColor: "#16745e", color: "#fff", fontSize: 28, fontWeight: "900", marginBottom: 16 },
  completionText: { color: "#173c33", fontSize: 25, fontWeight: "900" },
});
