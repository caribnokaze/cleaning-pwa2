import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useMemo, useState } from "react";
import { Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import FastPhotoPicker, { PhotoPickerResult } from "./modules/fast-photo-picker/src";

type WorkType = "normal" | "full" | "regular" | "filter";
type Screen = "details" | "photos" | "review";
type Category = { id: string; label: string; hint?: string; group: "normal" | "regular" | "filter"; min: number; max: number };
type UploadCategory = { id: string; runId: string; assetIds: string[] };
type UploadJob = { version: 1; date: string; site: string; staff: string; workType: WorkType; workTime: string; categories: UploadCategory[]; createdAt: string };
type UploadSummary = { requested: number; uploaded: number; bytes: number; preparationMs: number; uploadMs: number; automaticRetries: number; deleted?: number };

const STAGING_API_URL = (process.env.EXPO_PUBLIC_MOBILE_STAGING_API_URL || "").replace(/\/$/, "");
const UPLOAD_JOB_KEY = "tocoro.production-ui.staging-upload.v1";

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

export default function App() {
  const [screen, setScreen] = useState<Screen>("details");
  const [cleaningDate, setCleaningDate] = useState(localDateString);
  const [staffName, setStaffName] = useState("");
  const [siteName, setSiteName] = useState("");
  const [workType, setWorkType] = useState<WorkType>("normal");
  const [workTime, setWorkTime] = useState("");
  const [selections, setSelections] = useState<Record<string, PhotoPickerResult>>({});
  const [isPicking, setIsPicking] = useState(false);
  const [error, setError] = useState("");
  const [password, setPassword] = useState("");
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [uploadJob, setUploadJob] = useState<UploadJob | null>(null);
  const [authToken, setAuthToken] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);

  useEffect(() => {
    AsyncStorage.getItem(UPLOAD_JOB_KEY).then((stored) => {
      if (!stored) return;
      const parsed: unknown = JSON.parse(stored);
      if (!isUploadJob(parsed)) return AsyncStorage.removeItem(UPLOAD_JOB_KEY);
      setUploadJob(parsed);
      setCleaningDate(parsed.date); setSiteName(parsed.site); setStaffName(parsed.staff);
      setWorkType(parsed.workType); setWorkTime(parsed.workTime);
      setSelections(Object.fromEntries(parsed.categories.map((item) => [item.id, { assetIds: item.assetIds, dismissalMs: 0 }])));
      setScreen("review");
      setUploadPhase("未完了の送信があります。パスワードを入力して再開してください。");
    }).catch(() => setError("中断した送信情報を読み込めませんでした。"));
  }, []);

  const visibleCategories = useMemo(() => CATEGORIES.filter((category) =>
    category.group === "normal" ||
    (category.group === "regular" && includesRegular(workType)) ||
    (category.group === "filter" && includesFilter(workType))), [workType]);
  const detailsValid = /^\d{4}-\d{2}-\d{2}$/.test(cleaningDate.trim()) && !!staffName.trim() && !!siteName.trim();
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

  const login = async () => {
    const response = await fetch(`${STAGING_API_URL}/api/mobile/login`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password }),
    });
    const body = await response.json();
    if (!response.ok || !body.token) throw new Error(body.error || "検証環境へログインできませんでした");
    return body.token as string;
  };

  const runUpload = async (job: UploadJob) => {
    if (!STAGING_API_URL) throw new Error("検証APIのURLが設定されていません。");
    if (!FastPhotoPicker) throw new Error("写真送信機能を利用できません。");
    const token = await login();
    setAuthToken(token);
    let uploaded = 0, bytes = 0, preparationMs = 0, uploadMs = 0, automaticRetries = 0;
    for (let categoryIndex = 0; categoryIndex < job.categories.length; categoryIndex += 1) {
      const item = job.categories[categoryIndex];
      const category = CATEGORIES.find((candidate) => candidate.id === item.id);
      const files = item.assetIds.map((_, index) => ({ filename: `${String(index + 1).padStart(3, "0")}.jpg` }));
      setUploadPhase(`${categoryIndex + 1}/${job.categories.length} ${category?.label || item.id}：保存済み写真を確認中…`);
      const beforeResponse = await fetch(`${STAGING_API_URL}/api/mobile-test/runs/${item.runId}`, { headers: { authorization: `Bearer ${token}` } });
      const beforeBody = await beforeResponse.json();
      if (!beforeResponse.ok) throw new Error(beforeBody.error || "保存済み写真を確認できませんでした");
      const stored = new Set<string>(beforeBody.filenames || []);
      const missing = files.map((file, index) => stored.has(file.filename) ? -1 : index).filter((index) => index >= 0);
      if (missing.length) {
        setUploadPhase(`${categoryIndex + 1}/${job.categories.length} ${category?.label || item.id}：${missing.length}枚を準備・送信中…`);
        const signedResponse = await fetch(`${STAGING_API_URL}/api/mobile-test/presigned-urls`, {
          method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: JSON.stringify({ runId: item.runId, date: job.date, site: job.site, staff: job.staff, files: missing.map((index) => files[index]) }),
        });
        const targets = await signedResponse.json();
        if (!signedResponse.ok || !Array.isArray(targets)) throw new Error(targets.error || "送信URLを取得できませんでした");
        const nativeResult = await FastPhotoPicker.prepareAndUploadPhotos(
          missing.map((index) => item.assetIds[index]), targets.map((target: { uploadUrl: string }) => target.uploadUrl), 720, 0.45, "none",
        );
        preparationMs += nativeResult.preparationMs; uploadMs += nativeResult.uploadMs;
        automaticRetries += nativeResult.automaticRetryCount;
      }
      const verifyResponse = await fetch(`${STAGING_API_URL}/api/mobile-test/runs/${item.runId}`, { headers: { authorization: `Bearer ${token}` } });
      const verified = await verifyResponse.json();
      if (!verifyResponse.ok || verified.photoCount !== item.assetIds.length) {
        throw new Error(`${category?.label || item.id}：${item.assetIds.length - (verified.photoCount || 0)}枚が未送信です`);
      }
      uploaded += verified.photoCount; bytes += verified.totalBytes;
      setUploadSummary({ requested: job.categories.reduce((sum, entry) => sum + entry.assetIds.length, 0), uploaded, bytes, preparationMs, uploadMs, automaticRetries });
    }
    setPassword("");
    setUploadPhase("全カテゴリーの検証S3保存を確認しました。確認後に削除してください。");
  };

  const startUpload = async () => {
    if (!password || isUploading || !FastPhotoPicker) return;
    const stamp = Date.now();
    const categories = visibleCategories.filter((category) => (selections[category.id]?.assetIds.length ?? 0) > 0).map((category) => ({
      id: category.id, runId: `${Platform.OS}-${stamp}-${category.id}`.slice(0, 64), assetIds: selections[category.id].assetIds,
    }));
    const job: UploadJob = { version: 1, date: cleaningDate.trim(), site: siteName.trim(), staff: staffName.trim(), workType, workTime, categories, createdAt: new Date().toISOString() };
    setError(""); setUploadSummary(null); setIsUploading(true); setUploadJob(job);
    try { await AsyncStorage.setItem(UPLOAD_JOB_KEY, JSON.stringify(job)); await runUpload(job); }
    catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); setUploadPhase("送信を中断しました。未完了分だけ再開できます。"); }
    finally { setIsUploading(false); }
  };

  const resumeUpload = async () => {
    if (!uploadJob || !password || isUploading) return;
    setError(""); setIsUploading(true);
    try { await runUpload(uploadJob); }
    catch (uploadError) { setError(uploadError instanceof Error ? uploadError.message : String(uploadError)); setUploadPhase("再開を中断しました。もう一度再開できます。"); }
    finally { setIsUploading(false); }
  };

  const deleteUpload = async () => {
    if (!uploadJob || !authToken || isDeleting) return;
    setError(""); setIsDeleting(true); setUploadPhase("検証S3から写真を削除中…");
    try {
      let deleted = 0;
      for (const item of uploadJob.categories) {
        const response = await fetch(`${STAGING_API_URL}/api/mobile-test/runs/${item.runId}`, { method: "DELETE", headers: { authorization: `Bearer ${authToken}` } });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || "検証写真を削除できませんでした");
        deleted += body.deletedCount || 0;
      }
      setUploadSummary((current) => current ? { ...current, deleted } : current);
      await AsyncStorage.removeItem(UPLOAD_JOB_KEY); setUploadJob(null); setAuthToken("");
      setUploadPhase(`検証S3から削除：${deleted}枚`);
    } catch (deleteError) { setError(deleteError instanceof Error ? deleteError.message : String(deleteError)); setUploadPhase("削除できませんでした。再ログインして再開してください。"); }
    finally { setIsDeleting(false); }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.header}><Text style={styles.brand}>TOCORO.</Text><Text style={styles.headerTitle}>清掃写真報告</Text></View>
      <View style={styles.steps}>
        {(["details", "photos", "review"] as Screen[]).map((step, index) => (
          <View key={step} style={styles.stepItem}>
            <View style={[styles.stepCircle, screen === step && styles.stepCircleActive]}><Text style={[styles.stepNumber, screen === step && styles.stepNumberActive]}>{index + 1}</Text></View>
            <Text style={[styles.stepLabel, screen === step && styles.stepLabelActive]}>{index === 0 ? "報告情報" : index === 1 ? "写真" : "確認"}</Text>
          </View>
        ))}
      </View>
      <ScrollView contentContainerStyle={styles.container} keyboardShouldPersistTaps="handled">
        {screen === "details" && <>
          <Text style={styles.title}>報告情報を入力</Text>
          <Text style={styles.description}>現在のWeb版と同じ情報を入力します。</Text>
          <Field label="清掃日"><TextInput style={styles.input} value={cleaningDate} onChangeText={setCleaningDate} placeholder="YYYY-MM-DD" autoCapitalize="none" /></Field>
          <Field label="担当者"><TextInput style={styles.input} value={staffName} onChangeText={setStaffName} placeholder="担当者名を検索・入力" /></Field>
          <Field label="現場"><TextInput style={styles.input} value={siteName} onChangeText={setSiteName} placeholder="現場名を検索・入力" /></Field>
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
          <Text style={styles.title}>カテゴリーごとに写真を選択</Text>
          <Text style={styles.description}>カテゴリーを押すと、3列の独自高速ピッカーが開きます。</Text>
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
          <View style={styles.notice}><Text style={styles.noticeTitle}>検証専用S3への送信です</Text><Text style={styles.noticeText}>本番には送信しません。確認後は、この画面からテスト写真を削除してください。</Text></View>
          <TextInput style={styles.passwordInput} value={password} onChangeText={setPassword} placeholder="検証環境のパスワード" secureTextEntry={!passwordVisible} autoCapitalize="none" autoCorrect={false} editable={!isUploading && !isDeleting} />
          <View style={styles.passwordHelp}><Text style={styles.passwordCount}>{password.length ? `入力済み：${password.length}文字` : "未入力"}</Text><Pressable onPress={() => setPasswordVisible((visible) => !visible)} disabled={isUploading || isDeleting}><Text style={styles.passwordToggle}>{passwordVisible ? "隠す" : "表示する"}</Text></Pressable></View>
          {!!uploadPhase && <Text style={styles.phase}>{uploadPhase}</Text>}
          {uploadSummary && <View style={styles.uploadResult}>
            <Text style={styles.groupTitle}>検証S3送信結果</Text>
            <ReviewLine label="成功" value={`${uploadSummary.uploaded}/${uploadSummary.requested}枚`} />
            <ReviewLine label="準備時間" value={`${uploadSummary.preparationMs}ms`} />
            <ReviewLine label="送信時間" value={`${uploadSummary.uploadMs}ms`} />
            <ReviewLine label="送信容量" value={`${(uploadSummary.bytes / 1024 / 1024).toFixed(1)}MB`} />
            <ReviewLine label="自動再試行" value={`${uploadSummary.automaticRetries}回`} />
            {uploadSummary.deleted !== undefined && <ReviewLine label="検証S3から削除" value={`${uploadSummary.deleted}枚`} strong />}
          </View>}
          <View style={styles.navigationRow}>
            {!uploadJob && <SecondaryButton label="写真を修正" onPress={() => setScreen("photos")} />}
            <PrimaryButton label={isUploading ? "送信中…" : uploadJob ? "未完了の送信を再開" : "検証S3へ送信"} onPress={uploadJob ? resumeUpload : startUpload} disabled={!password || isUploading || isDeleting || (!!uploadSummary && uploadSummary.uploaded === uploadSummary.requested)} compact />
          </View>
          {!!uploadJob && !!authToken && uploadSummary?.uploaded === uploadSummary?.requested && <Pressable style={[styles.deleteButton, isDeleting && styles.buttonDisabled]} onPress={deleteUpload} disabled={isDeleting}><Text style={styles.primaryButtonText}>{isDeleting ? "削除中…" : "確認済みのテスト写真を削除"}</Text></Pressable>}
        </>}
        {!!error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <View style={styles.field}><Text style={styles.sectionLabel}>{label} <Text style={styles.required}>必須</Text></Text>{children}</View>;
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
  header: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 10, flexDirection: "row", alignItems: "baseline", backgroundColor: "#fff", borderBottomWidth: 1, borderBottomColor: "#dce4e1" },
  brand: { fontSize: 23, fontWeight: "900", color: "#12634f", marginRight: 10 },
  headerTitle: { fontSize: 16, fontWeight: "700", color: "#36564e" },
  steps: { flexDirection: "row", justifyContent: "space-around", paddingVertical: 12, backgroundColor: "#fff" },
  stepItem: { flexDirection: "row", alignItems: "center" },
  stepCircle: { width: 24, height: 24, borderRadius: 12, alignItems: "center", justifyContent: "center", backgroundColor: "#e4ebe8", marginRight: 6 },
  stepCircleActive: { backgroundColor: "#16745e" }, stepNumber: { fontSize: 12, fontWeight: "800", color: "#60706c" }, stepNumberActive: { color: "#fff" }, stepLabel: { fontSize: 12, color: "#788781" }, stepLabelActive: { color: "#16745e", fontWeight: "800" },
  container: { padding: 20, paddingBottom: 48 }, title: { fontSize: 24, fontWeight: "900", color: "#173c33", marginTop: 4 }, description: { fontSize: 14, lineHeight: 21, color: "#60706c", marginTop: 8, marginBottom: 20 },
  field: { marginBottom: 17 }, sectionLabel: { color: "#294b42", fontSize: 15, fontWeight: "800", marginBottom: 8 }, required: { color: "#b42318", fontSize: 11 },
  input: { borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, paddingHorizontal: 14, paddingVertical: 13, fontSize: 16, backgroundColor: "#fff" },
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
  passwordHelp: { marginTop: 8, flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  passwordCount: { color: "#60706c", fontSize: 13 }, passwordToggle: { color: "#16745e", fontSize: 14, fontWeight: "800", paddingVertical: 4, paddingHorizontal: 6 },
  phase: { marginTop: 13, color: "#36564e", fontSize: 14, lineHeight: 20, textAlign: "center" },
  uploadResult: { marginTop: 16, padding: 16, borderRadius: 12, backgroundColor: "#fff", borderWidth: 1, borderColor: "#bcd8cf" },
  deleteButton: { marginTop: 12, minHeight: 52, borderRadius: 12, backgroundColor: "#9b2c2c", alignItems: "center", justifyContent: "center", paddingHorizontal: 18 },
  error: { marginTop: 18, color: "#b42318", fontSize: 14, lineHeight: 20 },
});
