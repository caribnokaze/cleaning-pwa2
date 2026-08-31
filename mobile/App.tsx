import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { useEffect, useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from "react-native";
import FastPhotoPicker, {
  PhotoPreparationResult,
  PhotoPickerResult,
  PhotoUploadResult,
} from "./modules/fast-photo-picker/src";

const STAGING_API_URL = (
  process.env.EXPO_PUBLIC_MOBILE_STAGING_API_URL || ""
).replace(/\/$/, "");
const STAGING_API_CONFIGURATION_ERROR =
  "検証APIが設定されていません。EXPO_PUBLIC_MOBILE_STAGING_API_URLを設定してください。";

type StagingUploadResult = PhotoUploadResult & {
  date: string;
  site: string;
  staff: string;
  verifiedCount: number;
  verifiedBytes: number;
  deletedCount?: number;
  manualRetryRounds: number;
};

type PendingStagingRun = {
  runId: string;
  token: string;
  failedIndexes: number[];
};

type PersistedUploadJob = {
  version: 1;
  runId: string;
  date: string;
  site: string;
  staff: string;
  assetIds: string[];
  createdAt: string;
};

const UPLOAD_JOB_STORAGE_KEY = "tocoro.mobile-staging.pending-upload.v1";

const isPersistedUploadJob = (value: unknown): value is PersistedUploadJob => {
  if (!value || typeof value !== "object") return false;
  const job = value as Partial<PersistedUploadJob>;
  return job.version === 1 &&
    typeof job.runId === "string" &&
    typeof job.date === "string" &&
    typeof job.site === "string" &&
    typeof job.staff === "string" &&
    Array.isArray(job.assetIds) &&
    job.assetIds.length > 0 &&
    job.assetIds.length <= 100 &&
    job.assetIds.every((assetId) => typeof assetId === "string") &&
    typeof job.createdAt === "string";
};

const localDateString = () => {
  const now = new Date();
  const offset = now.getTimezoneOffset() * 60_000;
  return new Date(now.getTime() - offset).toISOString().slice(0, 10);
};

export default function App() {
  const [result, setResult] = useState<PhotoPickerResult | null>(null);
  const [pickerName, setPickerName] = useState("");
  const [preparation, setPreparation] = useState<PhotoPreparationResult | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [stagingPassword, setStagingPassword] = useState("");
  const [cleaningDate, setCleaningDate] = useState(localDateString);
  const [siteName, setSiteName] = useState("");
  const [staffName, setStaffName] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [simulateUploadFailures, setSimulateUploadFailures] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadResult, setUploadResult] = useState<StagingUploadResult | null>(null);
  const [pendingRun, setPendingRun] = useState<PendingStagingRun | null>(null);
  const [persistedJob, setPersistedJob] = useState<PersistedUploadJob | null>(null);
  const [isResuming, setIsResuming] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    AsyncStorage.getItem(UPLOAD_JOB_STORAGE_KEY)
      .then((stored) => {
        if (!stored) return;
        const parsed: unknown = JSON.parse(stored);
        if (!isPersistedUploadJob(parsed)) {
          return AsyncStorage.removeItem(UPLOAD_JOB_STORAGE_KEY);
        }
        setPersistedJob(parsed);
        setCleaningDate(parsed.date);
        setSiteName(parsed.site);
        setStaffName(parsed.staff);
        setResult({ assetIds: parsed.assetIds, dismissalMs: 0 });
        setPickerName("中断した送信から復帰");
        setUploadPhase("未完了の送信があります。パスワードを入力して再開してください。");
      })
      .catch(() => setError("中断データを読み込めませんでした。"));
  }, []);

  const openPicker = async (useSystemPicker: boolean) => {
    setError("");
    if (pendingRun || persistedJob) {
      setError("先に検証S3の写真を確認して削除してください。");
      return;
    }
    setPreparation(null);
    setUploadResult(null);
    setUploadPhase("");
    if ((Platform.OS !== "ios" && Platform.OS !== "android") || !FastPhotoPicker) {
      setError("この試作版の高速写真選択はiPhone・Android実機用です。");
      return;
    }
    try {
      const nextResult = useSystemPicker
        ? await FastPhotoPicker.pickPhotosWithSystemPicker(100)
        : await FastPhotoPicker.pickPhotos(100);
      setPickerName(
        useSystemPicker
          ? Platform.OS === "android"
            ? "Android標準ピッカー"
            : "Apple標準ピッカー"
          : "独自高速ピッカー"
      );
      setResult(nextResult);
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError));
    }
  };

  const prepareSelectedPhotos = async () => {
    if (!result || isPreparing || !FastPhotoPicker) return;
    setError("");
    setPreparation(null);
    setIsPreparing(true);
    try {
      const nextPreparation = await FastPhotoPicker.preparePhotos(
        result.assetIds,
        720,
        0.45,
      );
      setPreparation(nextPreparation);
    } catch (preparationError) {
      setError(
        preparationError instanceof Error
          ? preparationError.message
          : String(preparationError),
      );
    } finally {
      setIsPreparing(false);
    }
  };

  const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1);

  const uploadToStaging = async () => {
    if (!result || !stagingPassword || isUploading || !FastPhotoPicker) return;
    if (!STAGING_API_URL) {
      setError(STAGING_API_CONFIGURATION_ERROR);
      return;
    }
    const date = cleaningDate.trim();
    const site = siteName.trim();
    const staff = staffName.trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      setError("撮影日は YYYY-MM-DD 形式で入力してください。");
      return;
    }
    if (!site || !staff || /[\\/]/.test(site) || /[\\/]/.test(staff)) {
      setError("現場名と担当者名を入力してください（/ と \\ は使用できません）。");
      return;
    }
    setError("");
    setUploadResult(null);
    setIsUploading(true);
    setUploadPhase("検証環境へログイン中…");
    const runId = `${Platform.OS}-${Date.now()}`;
    const uploadJob: PersistedUploadJob = {
      version: 1,
      runId,
      date,
      site,
      staff,
      assetIds: result.assetIds,
      createdAt: new Date().toISOString(),
    };
    let token = "";
    let keepUploadedPhotos = false;
    let nativeResult: PhotoUploadResult | null = null;
    try {
      await AsyncStorage.setItem(UPLOAD_JOB_STORAGE_KEY, JSON.stringify(uploadJob));
      setPersistedJob(uploadJob);
      const loginResponse = await fetch(`${STAGING_API_URL}/api/mobile/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: stagingPassword }),
      });
      const loginBody = await loginResponse.json();
      if (!loginResponse.ok || !loginBody.token) {
        throw new Error(loginBody.error || "検証環境へログインできませんでした");
      }
      token = loginBody.token;

      setUploadPhase("100枚分のアップロードURLを取得中…");
      const files = result.assetIds.map((_, index) => ({
        filename: `${String(index + 1).padStart(3, "0")}.jpg`,
      }));
      const signedResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/presigned-urls`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ runId, date, site, staff, files }),
        },
      );
      const signedBody = await signedResponse.json();
      if (!signedResponse.ok || !Array.isArray(signedBody)) {
        throw new Error(signedBody.error || "アップロードURLを取得できませんでした");
      }

      setUploadPhase("写真を圧縮して検証S3へ送信中…");
      nativeResult = await FastPhotoPicker.prepareAndUploadPhotos(
        result.assetIds,
        signedBody.map((target: { uploadUrl: string }) => target.uploadUrl),
        720,
        0.45,
        simulateUploadFailures ? "manual-retry" : "none",
      );

      setUploadPhase("検証S3の保存内容を確認中…");
      const verifyResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${runId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const verifyBody = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(verifyBody.error || "検証写真を確認できませんでした");
      }
      const storedFilenames = new Set<string>(verifyBody.filenames || []);
      const failedIndexes = files
        .map((file, index) => (storedFilenames.has(file.filename) ? -1 : index))
        .filter((index) => index >= 0);
      keepUploadedPhotos = true;
      setPendingRun({ runId, token, failedIndexes });
      setUploadResult({
        ...nativeResult,
        uploadedCount: verifyBody.photoCount,
        failedCount: failedIndexes.length,
        uploadedBytes: verifyBody.totalBytes,
        failedIndexes,
        date,
        site,
        staff,
        verifiedCount: verifyBody.photoCount,
        verifiedBytes: verifyBody.totalBytes,
        manualRetryRounds: 0,
      });
      setStagingPassword("");
      setUploadPhase(
        failedIndexes.length
          ? `${failedIndexes.length}枚が未送信です（失敗分だけ再送してください）`
          : "保存確認完了（確認後に削除してください）",
      );
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      if (token && !keepUploadedPhotos) {
        setUploadPhase("エラー後のテスト写真を削除中…");
        try {
          const cleanupResponse = await fetch(
            `${STAGING_API_URL}/api/mobile-test/runs/${runId}`,
            { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
          );
          keepUploadedPhotos = !cleanupResponse.ok;
          if (cleanupResponse.ok) {
            await AsyncStorage.removeItem(UPLOAD_JOB_STORAGE_KEY);
            setPersistedJob(null);
          }
        } catch {
          keepUploadedPhotos = true;
        }
        setUploadPhase(
          !keepUploadedPhotos
            ? "エラー終了（送信済み写真は削除済み）"
            : "エラー終了（自動削除は1日後）",
        );
      }
      setIsUploading(false);
    }
  };

  const resumeInterruptedUpload = async () => {
    if (
      !persistedJob ||
      !stagingPassword ||
      isResuming ||
      !FastPhotoPicker
    ) return;
    if (!STAGING_API_URL) {
      setError(STAGING_API_CONFIGURATION_ERROR);
      return;
    }
    setError("");
    setIsResuming(true);
    setUploadResult(null);
    setUploadPhase("検証環境へ再ログイン中…");
    try {
      const loginResponse = await fetch(`${STAGING_API_URL}/api/mobile/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: stagingPassword }),
      });
      const loginBody = await loginResponse.json();
      if (!loginResponse.ok || !loginBody.token) {
        throw new Error(loginBody.error || "検証環境へログインできませんでした");
      }
      const token = loginBody.token as string;
      const allFiles = persistedJob.assetIds.map((_, index) => ({
        filename: `${String(index + 1).padStart(3, "0")}.jpg`,
      }));

      setUploadPhase("中断前に保存できた写真を確認中…");
      const beforeResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${persistedJob.runId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const beforeBody = await beforeResponse.json();
      if (!beforeResponse.ok) {
        throw new Error(beforeBody.error || "中断データを確認できませんでした");
      }
      const storedBefore = new Set<string>(beforeBody.filenames || []);
      const missingBefore = allFiles
        .map((file, index) => (storedBefore.has(file.filename) ? -1 : index))
        .filter((index) => index >= 0);

      let resumeResult: PhotoUploadResult = {
        requestedCount: persistedJob.assetIds.length,
        uploadedCount: beforeBody.photoCount,
        failedCount: missingBefore.length,
        preparationMs: 0,
        uploadMs: 0,
        totalMs: 0,
        uploadedBytes: beforeBody.totalBytes,
        firstError: "",
        failedIndexes: missingBefore,
        automaticRetryCount: 0,
      };

      if (missingBefore.length) {
        setUploadPhase(`${missingBefore.length}枚の再開用URLを取得中…`);
        const missingFiles = missingBefore.map((index) => allFiles[index]);
        const signedResponse = await fetch(
          `${STAGING_API_URL}/api/mobile-test/presigned-urls`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${token}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({
              runId: persistedJob.runId,
              date: persistedJob.date,
              site: persistedJob.site,
              staff: persistedJob.staff,
              files: missingFiles,
            }),
          },
        );
        const signedBody = await signedResponse.json();
        if (!signedResponse.ok || !Array.isArray(signedBody)) {
          throw new Error(signedBody.error || "再開用URLを取得できませんでした");
        }
        setUploadPhase(`未送信の${missingBefore.length}枚だけを再開中…`);
        resumeResult = await FastPhotoPicker.prepareAndUploadPhotos(
          missingBefore.map((index) => persistedJob.assetIds[index]),
          signedBody.map((target: { uploadUrl: string }) => target.uploadUrl),
          720,
          0.45,
          "none",
        );
      }

      setUploadPhase("再開後の保存内容を照合中…");
      const verifyResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${persistedJob.runId}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      const verifyBody = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(verifyBody.error || "再開後の保存内容を確認できませんでした");
      }
      const storedAfter = new Set<string>(verifyBody.filenames || []);
      const remainingIndexes = allFiles
        .map((file, index) => (storedAfter.has(file.filename) ? -1 : index))
        .filter((index) => index >= 0);
      setPendingRun({
        runId: persistedJob.runId,
        token,
        failedIndexes: remainingIndexes,
      });
      setUploadResult({
        ...resumeResult,
        requestedCount: persistedJob.assetIds.length,
        uploadedCount: verifyBody.photoCount,
        failedCount: remainingIndexes.length,
        uploadedBytes: verifyBody.totalBytes,
        failedIndexes: remainingIndexes,
        date: persistedJob.date,
        site: persistedJob.site,
        staff: persistedJob.staff,
        verifiedCount: verifyBody.photoCount,
        verifiedBytes: verifyBody.totalBytes,
        manualRetryRounds: missingBefore.length ? 1 : 0,
      });
      setStagingPassword("");
      setUploadPhase(
        remainingIndexes.length
          ? `再開後も${remainingIndexes.length}枚が未送信です`
          : "中断復帰完了・100枚の保存確認済み（確認後に削除してください）",
      );
    } catch (resumeError) {
      setError(resumeError instanceof Error ? resumeError.message : String(resumeError));
      setUploadPhase("中断復帰に失敗しました（もう一度再開できます）");
    } finally {
      setIsResuming(false);
    }
  };

  const retryFailedPhotos = async () => {
    if (
      !result ||
      !pendingRun ||
      !uploadResult ||
      !pendingRun.failedIndexes.length ||
      isRetrying ||
      !FastPhotoPicker
    ) return;
    if (!STAGING_API_URL) {
      setError(STAGING_API_CONFIGURATION_ERROR);
      return;
    }
    setError("");
    setIsRetrying(true);
    setUploadPhase(`${pendingRun.failedIndexes.length}枚の再送URLを取得中…`);
    try {
      const retryIndexes = pendingRun.failedIndexes;
      const files = retryIndexes.map((index) => ({
        filename: `${String(index + 1).padStart(3, "0")}.jpg`,
      }));
      const signedResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/presigned-urls`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${pendingRun.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            runId: pendingRun.runId,
            date: uploadResult.date,
            site: uploadResult.site,
            staff: uploadResult.staff,
            files,
          }),
        },
      );
      const signedBody = await signedResponse.json();
      if (!signedResponse.ok || !Array.isArray(signedBody)) {
        throw new Error(signedBody.error || "再送URLを取得できませんでした");
      }

      setUploadPhase(`${retryIndexes.length}枚だけを準備して再送中…`);
      const retryResult = await FastPhotoPicker.prepareAndUploadPhotos(
        retryIndexes.map((index) => result.assetIds[index]),
        signedBody.map((target: { uploadUrl: string }) => target.uploadUrl),
        720,
        0.45,
        "none",
      );

      const verifyResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${pendingRun.runId}`,
        { headers: { authorization: `Bearer ${pendingRun.token}` } },
      );
      const verifyBody = await verifyResponse.json();
      if (!verifyResponse.ok) {
        throw new Error(verifyBody.error || "再送後の保存内容を確認できませんでした");
      }
      const storedFilenames = new Set<string>(verifyBody.filenames || []);
      const remainingIndexes = result.assetIds
        .map((_, index) =>
          storedFilenames.has(`${String(index + 1).padStart(3, "0")}.jpg`)
            ? -1
            : index,
        )
        .filter((index) => index >= 0);

      setPendingRun({ ...pendingRun, failedIndexes: remainingIndexes });
      setUploadResult((current) => current ? {
        ...current,
        uploadedCount: verifyBody.photoCount,
        failedCount: remainingIndexes.length,
        failedIndexes: remainingIndexes,
        preparationMs: current.preparationMs + retryResult.preparationMs,
        uploadMs: current.uploadMs + retryResult.uploadMs,
        totalMs: current.totalMs + retryResult.totalMs,
        uploadedBytes: verifyBody.totalBytes,
        verifiedCount: verifyBody.photoCount,
        verifiedBytes: verifyBody.totalBytes,
        automaticRetryCount:
          current.automaticRetryCount + retryResult.automaticRetryCount,
        manualRetryRounds: current.manualRetryRounds + 1,
        firstError: remainingIndexes.length ? retryResult.firstError : "",
      } : current);
      setUploadPhase(
        remainingIndexes.length
          ? `再送後も${remainingIndexes.length}枚が未送信です`
          : "再送完了・100枚の保存確認済み（確認後に削除してください）",
      );
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : String(retryError));
      setUploadPhase("再送に失敗しました（もう一度再送できます）");
    } finally {
      setIsRetrying(false);
    }
  };

  const deleteStagingRun = async () => {
    if (!pendingRun || isDeleting) return;
    if (!STAGING_API_URL) {
      setError(STAGING_API_CONFIGURATION_ERROR);
      return;
    }
    setError("");
    setIsDeleting(true);
    setUploadPhase("確認済み写真を検証S3から削除中…");
    try {
      const response = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${pendingRun.runId}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${pendingRun.token}` },
        },
      );
      const body = await response.json();
      if (!response.ok) {
        throw new Error(body.error || "検証写真を削除できませんでした");
      }
      setUploadResult((current) =>
        current ? { ...current, deletedCount: body.deletedCount } : current,
      );
      setPendingRun(null);
      await AsyncStorage.removeItem(UPLOAD_JOB_STORAGE_KEY);
      setPersistedJob(null);
      setUploadPhase("完了（検証写真は削除済み）");
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
      setUploadPhase("削除できませんでした（自動削除は1日後）");
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>TOCORO. 写真選択テスト</Text>
        <Text style={styles.description}>
          写真本体を読み込む前に、端末内の写真IDだけを選択します。
          標準版と独自版で、操作性と100枚選択後の復帰時間を比較してください。
        </Text>

        <View style={styles.reportFields}>
          <Text style={styles.fieldLabel}>撮影日</Text>
          <TextInput
            style={styles.textInput}
            value={cleaningDate}
            onChangeText={setCleaningDate}
            placeholder="YYYY-MM-DD"
            autoCapitalize="none"
            editable={!isUploading && !pendingRun && !persistedJob}
          />
          <Text style={styles.fieldLabel}>現場名</Text>
          <TextInput
            style={styles.textInput}
            value={siteName}
            onChangeText={setSiteName}
            placeholder="例：テスト現場"
            editable={!isUploading && !pendingRun && !persistedJob}
          />
          <Text style={styles.fieldLabel}>担当者名</Text>
          <TextInput
            style={styles.textInput}
            value={staffName}
            onChangeText={setStaffName}
            placeholder="例：田中"
            editable={!isUploading && !pendingRun && !persistedJob}
          />
          <View style={styles.simulationRow}>
            <View style={styles.simulationText}>
              <Text style={styles.fieldLabel}>再送機能の試験</Text>
              <Text style={styles.gestureHint}>
                有効にすると10枚を意図的に失敗させます（ステージング限定）。
              </Text>
            </View>
            <Switch
              value={simulateUploadFailures}
              onValueChange={setSimulateUploadFailures}
              disabled={isUploading || !!pendingRun || !!persistedJob}
            />
          </View>
        </View>

        <Pressable style={styles.button} onPress={() => openPicker(true)}>
          <Text style={styles.buttonText}>
            {Platform.OS === "android" ? "Android標準ピッカー" : "Apple標準ピッカー"}
            （最大100枚）
          </Text>
        </Pressable>

        <Pressable style={[styles.button, styles.secondaryButton]} onPress={() => openPicker(false)}>
          <Text style={styles.buttonText}>独自高速ピッカー（比較用）</Text>
        </Pressable>
        <Text style={styles.gestureHint}>
          独自版では横方向になぞると連続選択／解除、縦方向はスクロールになります。
        </Text>

        {result && (
          <View style={styles.result}>
            <Text style={styles.resultTitle}>選択結果</Text>
            <Text style={styles.metric}>方式：{pickerName}</Text>
            <Text style={styles.metric}>選択枚数：{result.assetIds.length}枚</Text>
            <Text style={styles.metric}>画面復帰：約{result.dismissalMs}ms</Text>
            <Text style={styles.note}>
              選択直後は元画像を読み込んでいません。下のボタンで本番送信せず、
              読み込みと圧縮だけを測定できます。
            </Text>
            <Pressable
              style={[styles.button, styles.benchmarkButton, isPreparing && styles.disabledButton]}
              onPress={prepareSelectedPhotos}
              disabled={isPreparing || result.assetIds.length === 0}
            >
              <Text style={styles.buttonText}>
                {isPreparing ? "読み込み・圧縮中…" : "選択写真を準備して計測"}
              </Text>
            </Pressable>

            <Text style={[styles.note, styles.uploadHeading]}>
              実運用フロー：撮影日・現場名・担当者名と一緒に検証専用S3へ保存し、
              内容を確認してから削除します。未削除データも1日後に自動削除されます。
            </Text>
            <TextInput
              style={styles.passwordInput}
              value={stagingPassword}
              onChangeText={setStagingPassword}
              placeholder="検証環境のパスワード"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isUploading && !isResuming}
            />
            {persistedJob && !pendingRun && !isUploading ? (
              <Pressable
                style={[styles.button, styles.resumeButton, isResuming && styles.disabledButton]}
                onPress={resumeInterruptedUpload}
                disabled={isResuming || !stagingPassword}
              >
                <Text style={styles.buttonText}>
                  {isResuming ? "未完了の送信を再開中…" : "未完了の送信を再開"}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.button, styles.benchmarkButton, isUploading && styles.disabledButton]}
                onPress={uploadToStaging}
                disabled={
                  isUploading ||
                  !!pendingRun ||
                  !!persistedJob ||
                  !stagingPassword ||
                  !cleaningDate.trim() ||
                  !siteName.trim() ||
                  !staffName.trim() ||
                  result.assetIds.length === 0
                }
              >
                <Text style={styles.buttonText}>
                  {isUploading ? "実送信処理中…" : "選択写真を検証S3へ実送信"}
                </Text>
              </Pressable>
            )}
            {!!uploadPhase && <Text style={styles.phase}>{uploadPhase}</Text>}
            {uploadResult && (
              <View style={styles.preparationResult}>
                <Text style={styles.resultTitle}>検証S3送信結果</Text>
                <Text style={styles.metric}>準備：{uploadResult.preparationMs}ms</Text>
                <Text style={styles.metric}>送信：{uploadResult.uploadMs}ms</Text>
                <Text style={styles.metric}>合計：{uploadResult.totalMs}ms</Text>
                <Text style={styles.metric}>
                  成功：{uploadResult.uploadedCount}枚／失敗：{uploadResult.failedCount}枚
                </Text>
                <Text style={styles.metric}>
                  送信容量：{megabytes(uploadResult.uploadedBytes)}MB
                </Text>
                <Text style={styles.metric}>撮影日：{uploadResult.date}</Text>
                <Text style={styles.metric}>現場名：{uploadResult.site}</Text>
                <Text style={styles.metric}>担当者名：{uploadResult.staff}</Text>
                <Text style={styles.metric}>
                  検証S3で確認：{uploadResult.verifiedCount}枚／
                  {megabytes(uploadResult.verifiedBytes)}MB
                </Text>
                <Text style={styles.metric}>
                  自動再試行：{uploadResult.automaticRetryCount}回
                </Text>
                <Text style={styles.metric}>
                  手動再送：{uploadResult.manualRetryRounds}回
                </Text>
                {!!uploadResult.failedIndexes.length && (
                  <Text style={styles.error}>
                    未送信：{uploadResult.failedIndexes.map((index) => index + 1).join("、")}番
                  </Text>
                )}
                {uploadResult.deletedCount !== undefined && (
                  <Text style={styles.metric}>
                    検証S3から削除：{uploadResult.deletedCount}枚
                  </Text>
                )}
                {!!uploadResult.firstError && (
                  <Text style={styles.error}>{uploadResult.firstError}</Text>
                )}
                {!!pendingRun?.failedIndexes.length && (
                  <Pressable
                    style={[styles.button, styles.retryButton, isRetrying && styles.disabledButton]}
                    onPress={retryFailedPhotos}
                    disabled={isRetrying}
                  >
                    <Text style={styles.buttonText}>
                      {isRetrying
                        ? "失敗分を再送中…"
                        : `失敗した${pendingRun.failedIndexes.length}枚だけ再送`}
                    </Text>
                  </Pressable>
                )}
                {pendingRun && (
                  <Pressable
                    style={[styles.button, styles.deleteButton, isDeleting && styles.disabledButton]}
                    onPress={deleteStagingRun}
                    disabled={isDeleting}
                  >
                    <Text style={styles.buttonText}>
                      {isDeleting ? "削除中…" : "確認済みのテスト写真を削除"}
                    </Text>
                  </Pressable>
                )}
              </View>
            )}

            {preparation && (
              <View style={styles.preparationResult}>
                <Text style={styles.resultTitle}>準備結果（本番送信なし）</Text>
                <Text style={styles.metric}>処理時間：{preparation.totalMs}ms</Text>
                <Text style={styles.metric}>
                  成功：{preparation.preparedCount}枚／失敗：{preparation.failedCount}枚
                </Text>
                <Text style={styles.metric}>
                  元容量：{megabytes(preparation.sourceBytes)}MB
                </Text>
                <Text style={styles.metric}>
                  圧縮後：{megabytes(preparation.outputBytes)}MB
                </Text>
                <Text style={styles.note}>
                  幅720px・JPEG品質45%・同時処理2枚。現場で撮影して端末に
                  保存された原本のみを処理し、iCloud取得や外部送信は行いません。
                </Text>
              </View>
            )}
          </View>
        )}
        {!!error && <Text style={styles.error}>{error}</Text>}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f4f7f6" },
  container: { flexGrow: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 25, fontWeight: "800", color: "#173c33", marginBottom: 14 },
  description: { fontSize: 16, lineHeight: 25, color: "#42534f", marginBottom: 28 },
  button: { backgroundColor: "#16745e", padding: 17, borderRadius: 12, alignItems: "center" },
  secondaryButton: { marginTop: 12, backgroundColor: "#52605c" },
  gestureHint: { marginTop: 10, color: "#60706c", fontSize: 13, lineHeight: 19 },
  reportFields: { marginBottom: 22, padding: 16, borderRadius: 12, backgroundColor: "#fff" },
  fieldLabel: { marginTop: 8, marginBottom: 6, color: "#36564e", fontWeight: "700" },
  simulationRow: { marginTop: 14, flexDirection: "row", alignItems: "center" },
  simulationText: { flex: 1, paddingRight: 12 },
  textInput: {
    borderWidth: 1,
    borderColor: "#aebcb7",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  result: { marginTop: 28, padding: 20, borderRadius: 12, backgroundColor: "#fff" },
  resultTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12, color: "#173c33" },
  metric: { fontSize: 17, marginBottom: 8, color: "#1f2926" },
  note: { marginTop: 8, fontSize: 14, lineHeight: 21, color: "#60706c" },
  benchmarkButton: { marginTop: 16 },
  disabledButton: { opacity: 0.55 },
  preparationResult: { marginTop: 18, paddingTop: 16, borderTopWidth: 1, borderTopColor: "#dce4e1" },
  passwordInput: {
    marginTop: 16,
    borderWidth: 1,
    borderColor: "#aebcb7",
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 13,
    fontSize: 16,
    backgroundColor: "#fff",
  },
  uploadHeading: { marginTop: 22, fontWeight: "700", color: "#36564e" },
  deleteButton: { marginTop: 14, backgroundColor: "#9b2c2c" },
  retryButton: { marginTop: 14, backgroundColor: "#9a6700" },
  resumeButton: { marginTop: 16, backgroundColor: "#1d4f91" },
  phase: { marginTop: 12, color: "#36564e", fontSize: 15, textAlign: "center" },
  error: { marginTop: 20, color: "#b42318", fontSize: 15 },
});
