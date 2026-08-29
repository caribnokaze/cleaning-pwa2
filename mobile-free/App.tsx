import { StatusBar } from "expo-status-bar";
import { Image } from "expo-image";
import { File } from "expo-file-system";
import * as FileSystem from "expo-file-system/legacy";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import * as MediaLibrary from "expo-media-library";
import * as SecureStore from "expo-secure-store";
import { useEffect, useMemo, useRef, useState } from "react";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";

const MAX_SELECTION = 100;
const PAGE_SIZE = 200;
const COMPRESS_WIDTH = 720;
const COMPRESS_QUALITY = 0.45;
const COMPRESSION_WORKERS = 2;
const UPLOAD_WORKERS = 4;
const TOKEN_KEY = "tocoro_mobile_test_token";
const API_BASE_URL = (process.env.EXPO_PUBLIC_API_BASE_URL || "https://tocoro-report.com").replace(
  /\/$/,
  "",
);

type CompressionStatus = "idle" | "running" | "completed" | "cancelled";
type UploadStatus = "idle" | "preparing" | "running" | "completed" | "error";
type JobStatus =
  | "waiting"
  | "reading"
  | "compressing"
  | "ready"
  | "uploading"
  | "uploaded"
  | "failed"
  | "uploadFailed"
  | "cancelled"
  | "deleted";

type SelectedPhoto = {
  id: string;
  assetId?: string;
  sourceUri?: string;
  previewUri: string;
  width: number;
};

type PhotoJobView = {
  id: string;
  previewUri: string;
  status: JobStatus;
  uploadPercent: number;
  error: string;
};

type PhotoJob = PhotoJobView & {
  assetId?: string;
  sourceUri?: string;
  width: number;
  filename: string;
  compressedFile: File | null;
  preparation: Promise<File | null>;
  settlePreparation: (file: File | null) => void;
  preparationSettled: boolean;
  uploadUrl?: string;
};

type CompressionProgress = {
  status: CompressionStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  originalBytes: number;
  compressedBytes: number;
  elapsedMs: number;
  stage: string;
};

type UploadProgress = {
  status: UploadStatus;
  total: number;
  uploaded: number;
  failed: number;
  message: string;
};

const EMPTY_COMPRESSION: CompressionProgress = {
  status: "idle",
  total: 0,
  processed: 0,
  succeeded: 0,
  failed: 0,
  originalBytes: 0,
  compressedBytes: 0,
  elapsedMs: 0,
  stage: "",
};

const EMPTY_UPLOAD: UploadProgress = {
  status: "idle",
  total: 0,
  uploaded: 0,
  failed: 0,
  message: "",
};

const formatBytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;
const formatElapsed = (milliseconds: number) => `${(milliseconds / 1000).toFixed(1)}秒`;

const jobStatusLabel = (job: PhotoJobView) => {
  switch (job.status) {
    case "waiting":
      return "待機中";
    case "reading":
      return "読込中";
    case "compressing":
      return "圧縮中";
    case "ready":
      return "送信準備OK";
    case "uploading":
      return `送信 ${job.uploadPercent}%`;
    case "uploaded":
      return "送信完了";
    case "failed":
      return "圧縮失敗";
    case "uploadFailed":
      return "送信失敗";
    case "cancelled":
      return "中止";
    case "deleted":
      return "削除済み";
    default:
      return "";
  }
};

export default function App() {
  const { width } = useWindowDimensions();
  const [visible, setVisible] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [assets, setAssets] = useState<MediaLibrary.Asset[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [endCursor, setEndCursor] = useState<string | undefined>();
  const [hasNextPage, setHasNextPage] = useState(false);
  const [dismissalMs, setDismissalMs] = useState<number | null>(null);
  const [pickerLabel, setPickerLabel] = useState("");
  const [compression, setCompression] = useState<CompressionProgress>(EMPTY_COMPRESSION);
  const [upload, setUpload] = useState<UploadProgress>(EMPTY_UPLOAD);
  const [jobViews, setJobViews] = useState<PhotoJobView[]>([]);
  const [testRunId, setTestRunId] = useState<string | null>(null);
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [authChecking, setAuthChecking] = useState(true);
  const [password, setPassword] = useState("");
  const [loginBusy, setLoginBusy] = useState(false);

  const doneStartedAt = useRef(0);
  const compressionRunId = useRef(0);
  const selectedIdsRef = useRef<string[]>([]);
  const jobsRef = useRef<PhotoJob[]>([]);
  const listRef = useRef<FlatList<MediaLibrary.Asset>>(null);
  const gridRef = useRef<View>(null);
  const gridOrigin = useRef({ x: 0, y: 0 });
  const scrollOffset = useRef(0);
  const gridHeight = useRef(0);
  const dragAction = useRef<"select" | "deselect" | null>(null);
  const dragVisited = useRef(new Set<string>());
  const cellSize = Math.floor((width - 6) / 4);
  const cellPitch = cellSize + 2;

  const publishJobs = () => {
    setJobViews(
      jobsRef.current.map((job) => ({
        id: job.id,
        previewUri: job.previewUri,
        status: job.status,
        uploadPercent: job.uploadPercent,
        error: job.error,
      })),
    );
  };

  const clearAuthentication = async () => {
    setAuthToken(null);
    await SecureStore.deleteItemAsync(TOKEN_KEY);
  };

  const authorizedFetch = async (path: string, options: RequestInit = {}, token = authToken) => {
    if (!token) throw new Error("ログインが必要です");
    const headers = new Headers(options.headers);
    headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(`${API_BASE_URL}${path}`, { ...options, headers });
    if (response.status === 401) {
      await clearAuthentication();
      throw new Error("セッションが切れました。もう一度ログインしてください");
    }
    return response;
  };

  useEffect(() => {
    const restoreSession = async () => {
      try {
        const storedToken = await SecureStore.getItemAsync(TOKEN_KEY);
        if (!storedToken) return;
        const response = await fetch(`${API_BASE_URL}/api/session`, {
          headers: { Authorization: `Bearer ${storedToken}` },
        });
        if (response.ok) setAuthToken(storedToken);
        else await SecureStore.deleteItemAsync(TOKEN_KEY);
      } catch (error) {
        console.warn("セッション確認に失敗しました", error);
      } finally {
        setAuthChecking(false);
      }
    };
    void restoreSession();
  }, []);

  const login = async () => {
    if (!password || loginBusy) return;
    setLoginBusy(true);
    try {
      const response = await fetch(`${API_BASE_URL}/api/mobile/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const body = await response.json();
      if (!response.ok || !body.token) throw new Error(body.error || "ログインできませんでした");
      await SecureStore.setItemAsync(TOKEN_KEY, body.token);
      setAuthToken(body.token);
      setPassword("");
    } catch (error) {
      Alert.alert("ログインできません", error instanceof Error ? error.message : String(error));
    } finally {
      setLoginBusy(false);
      setAuthChecking(false);
    }
  };

  const fetchAssets = async (after?: string) => {
    const page = await MediaLibrary.getAssetsAsync({
      first: PAGE_SIZE,
      after,
      mediaType: [MediaLibrary.MediaType.photo],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    setAssets((current) => (after ? [...current, ...page.assets] : page.assets));
    setEndCursor(page.endCursor);
    setHasNextPage(page.hasNextPage);
  };

  const cleanLocalJobFiles = () => {
    for (const job of jobsRef.current) {
      try {
        if (job.compressedFile?.exists) job.compressedFile.delete();
      } catch (error) {
        console.warn("一時ファイルを削除できませんでした", error);
      }
      job.compressedFile = null;
    }
  };

  const settleJob = (job: PhotoJob, file: File | null) => {
    if (job.preparationSettled) return;
    job.preparationSettled = true;
    job.settlePreparation(file);
  };

  const startCompression = async (jobs: PhotoJob[], runId: number) => {
    const startedAt = performance.now();
    let cursor = 0;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    let originalBytes = 0;
    let compressedBytes = 0;
    let stage = "写真本体を取得中";

    const publish = (status: CompressionStatus = "running") => {
      if (compressionRunId.current !== runId) return;
      setCompression({
        status,
        total: jobs.length,
        processed,
        succeeded,
        failed,
        originalBytes,
        compressedBytes,
        elapsedMs: Math.round(performance.now() - startedAt),
        stage,
      });
    };

    publish();

    const worker = async () => {
      while (compressionRunId.current === runId) {
        const index = cursor++;
        if (index >= jobs.length) return;
        const job = jobs[index];
        let compressedFile: File | null = null;

        try {
          job.status = "reading";
          publishJobs();
          stage = "写真本体を取得中";
          publish();

          let sourceUri = job.sourceUri;
          if (!sourceUri && job.assetId) {
            const assetInfo = await MediaLibrary.getAssetInfoAsync(job.assetId, {
              shouldDownloadFromNetwork: true,
            });
            sourceUri = assetInfo.localUri ?? assetInfo.uri;
            job.width = assetInfo.width;
          }
          if (!sourceUri) throw new Error("写真本体を取得できませんでした");
          if (compressionRunId.current !== runId) return;

          const sourceFile = new File(sourceUri);
          job.status = "compressing";
          publishJobs();
          stage = "圧縮中";
          publish();

          const context = ImageManipulator.manipulate(sourceUri);
          if (job.width > COMPRESS_WIDTH) context.resize({ width: COMPRESS_WIDTH });
          const renderedImage = await context.renderAsync();
          const result = await renderedImage.saveAsync({
            compress: COMPRESS_QUALITY,
            format: SaveFormat.JPEG,
          });
          compressedFile = new File(result.uri);

          if (compressionRunId.current !== runId) {
            if (compressedFile.exists) compressedFile.delete();
            return;
          }

          originalBytes += sourceFile.size;
          compressedBytes += compressedFile.size;
          job.compressedFile = compressedFile;
          job.status = "ready";
          succeeded += 1;
          settleJob(job, compressedFile);
        } catch (error) {
          failed += 1;
          job.status = "failed";
          job.error = error instanceof Error ? error.message : String(error);
          settleJob(job, null);
          console.warn(`写真 ${index + 1} の圧縮に失敗しました`, error);
        } finally {
          processed += 1;
          stage = processed < jobs.length ? "圧縮を続行中" : "集計中";
          publishJobs();
          publish();
        }
      }
    };

    await Promise.all(
      Array.from({ length: Math.min(COMPRESSION_WORKERS, jobs.length) }, () => worker()),
    );

    if (compressionRunId.current === runId) {
      stage = failed ? "一部の写真で圧縮エラーが発生しました" : "圧縮完了";
      publish("completed");
    }
  };

  const initializeJobs = (photos: SelectedPhoto[], label: string) => {
    compressionRunId.current += 1;
    cleanLocalJobFiles();
    const runId = compressionRunId.current;
    const jobs = photos.map<PhotoJob>((photo, index) => {
      let resolver: (file: File | null) => void = () => undefined;
      const preparation = new Promise<File | null>((resolve) => {
        resolver = resolve;
      });
      return {
        ...photo,
        filename: `${String(index + 1).padStart(3, "0")}.jpg`,
        status: "waiting",
        uploadPercent: 0,
        error: "",
        compressedFile: null,
        preparation,
        settlePreparation: resolver,
        preparationSettled: false,
      };
    });

    jobsRef.current = jobs;
    setPickerLabel(label);
    setJobViews(jobs.map(({ id, previewUri, status, uploadPercent, error }) => ({
      id,
      previewUri,
      status,
      uploadPercent,
      error,
    })));
    setCompression({ ...EMPTY_COMPRESSION, status: "running", total: jobs.length });
    setUpload(EMPTY_UPLOAD);
    setTestRunId(null);
    void startCompression(jobs, runId);
  };

  const openPicker = async () => {
    setLoading(true);
    try {
      const permission = await MediaLibrary.requestPermissionsAsync(false, ["photo"]);
      if (!permission.granted) {
        Alert.alert(
          "写真へのアクセスが必要です",
          "設定から写真へのアクセスを許可してください。",
        );
        return;
      }
      setSelectedIds([]);
      selectedIdsRef.current = [];
      setAssets([]);
      await fetchAssets();
      setVisible(true);
    } finally {
      setLoading(false);
    }
  };

  const openSystemPicker = async () => {
    if (loading) return;
    setLoading(true);
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ["images"],
        allowsMultipleSelection: true,
        orderedSelection: true,
        selectionLimit: MAX_SELECTION,
        quality: 1,
      });
      if (result.canceled || !result.assets?.length) return;
      setDismissalMs(null);
      initializeJobs(
        result.assets.map((asset, index) => ({
          id: asset.assetId || `system-${Date.now()}-${index}`,
          sourceUri: asset.uri,
          previewUri: asset.uri,
          width: asset.width,
        })),
        "iPhone標準フォトライブラリー",
      );
    } catch (error) {
      Alert.alert("写真を選択できません", error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!hasNextPage || !endCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      await fetchAssets(endCursor);
    } finally {
      setLoadingMore(false);
    }
  };

  const toggleAsset = (assetId: string) => {
    setSelectedIds((current) => {
      if (current.includes(assetId)) {
        const next = current.filter((id) => id !== assetId);
        selectedIdsRef.current = next;
        return next;
      }
      if (current.length >= MAX_SELECTION) {
        Alert.alert("選択上限", `写真は最大${MAX_SELECTION}枚です。`);
        return current;
      }
      const next = [...current, assetId];
      selectedIdsRef.current = next;
      return next;
    });
  };

  const updateDragSelection = (pageX: number, pageY: number) => {
    const x = pageX - gridOrigin.current.x;
    const y = pageY - gridOrigin.current.y;
    if (x < 0 || y < 0 || x >= width || y >= gridHeight.current) return;
    const column = Math.max(0, Math.min(3, Math.floor(x / cellPitch)));
    const row = Math.max(0, Math.floor((y + scrollOffset.current) / cellPitch));
    const asset = assets[row * 4 + column];
    if (!asset || dragVisited.current.has(asset.id)) return;

    if (!dragAction.current) {
      dragAction.current = selectedIdsRef.current.includes(asset.id) ? "deselect" : "select";
    }
    dragVisited.current.add(asset.id);
    const current = selectedIdsRef.current;
    let next = current;
    if (dragAction.current === "select" && !current.includes(asset.id)) {
      if (current.length >= MAX_SELECTION) return;
      next = [...current, asset.id];
    } else if (dragAction.current === "deselect" && current.includes(asset.id)) {
      next = current.filter((id) => id !== asset.id);
    }
    if (next !== current) {
      selectedIdsRef.current = next;
      setSelectedIds(next);
    }

    const edge = 55;
    if (y > gridHeight.current - edge) {
      const nextOffset = scrollOffset.current + 22;
      listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
      scrollOffset.current = nextOffset;
    } else if (y < edge && scrollOffset.current > 0) {
      const nextOffset = Math.max(0, scrollOffset.current - 22);
      listRef.current?.scrollToOffset({ offset: nextOffset, animated: false });
      scrollOffset.current = nextOffset;
    }
  };

  const dragResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dx) > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.1,
        onPanResponderGrant: (event) => {
          dragAction.current = null;
          dragVisited.current.clear();
          updateDragSelection(event.nativeEvent.pageX, event.nativeEvent.pageY);
        },
        onPanResponderMove: (event) =>
          updateDragSelection(event.nativeEvent.pageX, event.nativeEvent.pageY),
        onPanResponderRelease: () => {
          dragAction.current = null;
          dragVisited.current.clear();
        },
        onPanResponderTerminate: () => {
          dragAction.current = null;
          dragVisited.current.clear();
        },
      }),
    [assets, cellPitch],
  );

  const finishSelection = () => {
    if (!selectedIds.length) return;
    doneStartedAt.current = performance.now();
    setVisible(false);
    if (Platform.OS !== "ios") {
      setTimeout(handleDismiss, 0);
    }
  };

  const handleDismiss = () => {
    if (!doneStartedAt.current) return;
    setDismissalMs(Math.round(performance.now() - doneStartedAt.current));
    doneStartedAt.current = 0;
    const assetById = new Map(assets.map((asset) => [asset.id, asset]));
    const photos = selectedIdsRef.current
      .map((assetId) => assetById.get(assetId))
      .filter((asset): asset is MediaLibrary.Asset => Boolean(asset))
      .map((asset) => ({
        id: asset.id,
        assetId: asset.id,
        previewUri: asset.uri,
        width: asset.width,
      }));
    initializeJobs(photos, "高速選択画面");
  };

  const cancelCompression = () => {
    compressionRunId.current += 1;
    for (const job of jobsRef.current) {
      if (!job.preparationSettled) {
        job.status = "cancelled";
        settleJob(job, null);
      }
    }
    publishJobs();
    setCompression((current) => ({
      ...current,
      status: "cancelled",
      stage: "圧縮を中止しました",
    }));
  };

  const startTestUpload = async () => {
    if (!authToken || !jobsRef.current.length || upload.status === "running") return;
    const jobs = jobsRef.current;
    const runId = testRunId || `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setTestRunId(runId);
    setUpload({ status: "preparing", total: jobs.length, uploaded: 0, failed: 0, message: "送信URLを準備中" });

    try {
      const response = await authorizedFetch("/api/mobile-test/presigned-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          runId,
          files: jobs.map((job) => ({ filename: job.filename })),
        }),
      });
      const targets = await response.json();
      if (!response.ok || !Array.isArray(targets) || targets.length !== jobs.length) {
        throw new Error(targets.error || "送信URLを取得できませんでした");
      }
      targets.forEach((target, index) => {
        jobs[index].uploadUrl = target.uploadUrl;
        jobs[index].uploadPercent = 0;
      });
      publishJobs();

      let cursor = 0;
      let uploadedCount = 0;
      let failedCount = 0;
      setUpload({ status: "running", total: jobs.length, uploaded: 0, failed: 0, message: "圧縮済み写真から送信中" });

      const worker = async () => {
        while (cursor < jobs.length) {
          const index = cursor++;
          const job = jobs[index];
          const file = await job.preparation;
          if (!file || !job.uploadUrl) {
            failedCount += 1;
            if (job.status !== "failed" && job.status !== "cancelled") job.status = "uploadFailed";
            publishJobs();
            setUpload({ status: "running", total: jobs.length, uploaded: uploadedCount, failed: failedCount, message: "送信を継続中" });
            continue;
          }

          try {
            job.status = "uploading";
            job.uploadPercent = 0;
            publishJobs();
            let lastPublishedPercent = -10;
            const uploadTask = FileSystem.createUploadTask(
              job.uploadUrl,
              file.uri,
              {
                httpMethod: "PUT",
                headers: { "Content-Type": "image/jpeg" },
                uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
                sessionType: FileSystem.FileSystemSessionType.BACKGROUND,
              },
              ({ totalBytesSent, totalBytesExpectedToSend }) => {
                const percent = totalBytesExpectedToSend
                  ? Math.round((totalBytesSent / totalBytesExpectedToSend) * 100)
                  : 0;
                if (percent >= lastPublishedPercent + 10 || percent === 100) {
                  lastPublishedPercent = percent;
                  job.uploadPercent = percent;
                  publishJobs();
                }
              },
            );
            const result = await uploadTask.uploadAsync();
            if (!result || result.status < 200 || result.status >= 300) {
              throw new Error(`S3応答: ${result?.status || "不明"}`);
            }
            job.status = "uploaded";
            job.uploadPercent = 100;
            uploadedCount += 1;
          } catch (error) {
            failedCount += 1;
            job.status = "uploadFailed";
            job.error = error instanceof Error ? error.message : String(error);
          }
          publishJobs();
          setUpload({
            status: "running",
            total: jobs.length,
            uploaded: uploadedCount,
            failed: failedCount,
            message: "圧縮完了した写真から送信中",
          });
        }
      };

      await Promise.all(
        Array.from({ length: Math.min(UPLOAD_WORKERS, jobs.length) }, () => worker()),
      );
      if (!failedCount) cleanLocalJobFiles();
      setUpload({
        status: failedCount ? "error" : "completed",
        total: jobs.length,
        uploaded: uploadedCount,
        failed: failedCount,
        message: failedCount ? "一部の写真を送信できませんでした" : "S3テスト送信完了",
      });
    } catch (error) {
      setUpload((current) => ({
        ...current,
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      }));
      Alert.alert("テスト送信に失敗しました", error instanceof Error ? error.message : String(error));
    }
  };

  const deleteTestRun = async () => {
    if (!testRunId || !authToken) return;
    try {
      const response = await authorizedFetch(
        `/api/mobile-test/runs/${encodeURIComponent(testRunId)}`,
        { method: "DELETE" },
      );
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "削除できませんでした");
      for (const job of jobsRef.current) job.status = "deleted";
      publishJobs();
      setTestRunId(null);
      Alert.alert("削除完了", `S3からテスト写真を${body.deletedCount}枚削除しました。`);
    } catch (error) {
      Alert.alert("削除できません", error instanceof Error ? error.message : String(error));
    }
  };

  const compressionRatio =
    compression.originalBytes > 0
      ? Math.max(
          0,
          Math.round((1 - compression.compressedBytes / compression.originalBytes) * 100),
        )
      : 0;
  const busy =
    compression.status === "running" ||
    upload.status === "running" ||
    upload.status === "preparing" ||
    Boolean(testRunId);
  const uploadAverage = jobViews.length
    ? Math.round(jobViews.reduce((sum, job) => sum + job.uploadPercent, 0) / jobViews.length)
    : 0;

  if (authChecking) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea}>
          <View style={styles.centered}><ActivityIndicator color="#16745e" size="large" /></View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  if (!authToken) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.safeArea}>
          <StatusBar style="dark" />
          <View style={styles.loginContainer}>
            <Text style={styles.title}>TOCORO. S3テスト</Text>
            <Text style={styles.description}>本番Webと同じパスワードでログインしてください。</Text>
            <TextInput
              style={styles.passwordInput}
              value={password}
              onChangeText={setPassword}
              onSubmitEditing={() => void login()}
              secureTextEntry
              textContentType="password"
              placeholder="パスワード"
              returnKeyType="go"
            />
            <Pressable style={styles.openButton} onPress={() => void login()} disabled={loginBusy || !password}>
              {loginBusy ? <ActivityIndicator color="#fff" /> : <Text style={styles.openButtonText}>ログイン</Text>}
            </Pressable>
          </View>
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.safeArea}>
        <StatusBar style="dark" />
        <ScrollView contentContainerStyle={styles.container}>
          <View style={styles.titleRow}>
            <Text style={styles.title}>TOCORO. 写真送信テスト</Text>
            <Pressable onPress={() => void clearAuthentication()}><Text style={styles.logout}>ログアウト</Text></Pressable>
          </View>
          <Text style={styles.description}>
            高速選択とiPhone標準画面を比較し、圧縮後の写真をテスト専用S3フォルダーへ送信します。
          </Text>

          <Pressable style={[styles.openButton, busy && styles.buttonDisabled]} onPress={openPicker} disabled={loading || busy}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.openButtonText}>高速選択画面（最大100枚）</Text>}
          </Pressable>
          <Pressable style={[styles.systemButton, busy && styles.buttonDisabled]} onPress={openSystemPicker} disabled={loading || busy}>
            <Text style={styles.systemButtonText}>iPhone標準フォトライブラリー</Text>
          </Pressable>

          {jobViews.length > 0 && (
            <View style={styles.result}>
              <Text style={styles.resultTitle}>選択結果</Text>
              <Text style={styles.metric}>選択方法：{pickerLabel}</Text>
              <Text style={styles.metric}>選択枚数：{jobViews.length}枚</Text>
              {dismissalMs !== null && <Text style={styles.metric}>画面復帰：約{dismissalMs}ms</Text>}

              <View style={styles.previewRow}>
                {jobViews.slice(0, 5).map((job) => (
                  <View key={job.id} style={styles.previewItem}>
                    <Image source={{ uri: job.previewUri }} style={styles.previewImage} contentFit="cover" />
                    <Text style={styles.previewStatus} numberOfLines={1}>{jobStatusLabel(job)}</Text>
                  </View>
                ))}
              </View>
              {jobViews.length > 5 && <Text style={styles.note}>ほか{jobViews.length - 5}枚も裏側で処理します。</Text>}

              <View style={styles.compressionPanel}>
                <View style={styles.progressHeader}>
                  {compression.status === "running" && <ActivityIndicator color="#16745e" />}
                  <Text style={styles.progressTitle}>{compression.stage}</Text>
                </View>
                <View style={styles.progressTrack}>
                  <View style={[styles.progressFill, { width: `${compression.total ? (compression.processed / compression.total) * 100 : 0}%` }]} />
                </View>
                <Text style={styles.metric}>圧縮：{compression.processed} / {compression.total}枚</Text>
                <Text style={styles.metric}>圧縮成功：{compression.succeeded}枚　失敗：{compression.failed}枚</Text>
                <Text style={styles.metric}>元容量：{formatBytes(compression.originalBytes)}</Text>
                <Text style={styles.metric}>圧縮後：{formatBytes(compression.compressedBytes)}（約{compressionRatio}%削減）</Text>
                <Text style={styles.metric}>圧縮時間：{formatElapsed(compression.elapsedMs)}</Text>
                {compression.status === "running" && upload.status === "idle" && (
                  <Pressable style={styles.cancelCompressionButton} onPress={cancelCompression}>
                    <Text style={styles.cancelCompressionText}>圧縮を中止</Text>
                  </Pressable>
                )}
              </View>

              {upload.status !== "idle" && (
                <View style={styles.uploadPanel}>
                  <Text style={styles.progressTitle}>{upload.message}</Text>
                  <View style={styles.progressTrack}>
                    <View style={[styles.uploadFill, { width: `${uploadAverage}%` }]} />
                  </View>
                  <Text style={styles.metric}>送信完了：{upload.uploaded} / {upload.total}枚</Text>
                  <Text style={styles.metric}>送信失敗：{upload.failed}枚</Text>
                </View>
              )}

              {(upload.status === "idle" || (upload.status === "error" && compression.failed === 0)) && compression.status !== "cancelled" && (
                <Pressable style={styles.sendButton} onPress={() => void startTestUpload()}>
                  <Text style={styles.openButtonText}>{upload.status === "error" ? "もう一度テスト送信" : "テスト専用S3へ送信"}</Text>
                </Pressable>
              )}
              {testRunId && (upload.status === "completed" || upload.status === "error") && (
                <Pressable style={styles.deleteButton} onPress={() => void deleteTestRun()}>
                  <Text style={styles.deleteButtonText}>このテスト写真をS3から削除</Text>
                </Pressable>
              )}
              <Text style={styles.note}>保存先：_system/mobile-test/（清掃写真一覧には表示されません）</Text>
            </View>
          )}
        </ScrollView>

        <Modal visible={visible} animationType="slide" presentationStyle="fullScreen" onDismiss={handleDismiss}>
          <SafeAreaProvider>
            <SafeAreaView style={styles.pickerSafeArea} edges={["top", "right", "bottom", "left"]}>
              <View style={styles.toolbar}>
                <Pressable onPress={() => setVisible(false)}><Text style={styles.cancel}>キャンセル</Text></Pressable>
                <Text style={styles.toolbarTitle}>写真を選択</Text>
                <Pressable onPress={finishSelection} disabled={!selectedIds.length}>
                  <Text style={[styles.done, !selectedIds.length && styles.disabled]}>完了（{selectedIds.length}）</Text>
                </Pressable>
              </View>
              <View
                ref={gridRef}
                style={styles.grid}
                onLayout={(event) => {
                  gridHeight.current = event.nativeEvent.layout.height;
                  gridRef.current?.measureInWindow((x, y) => { gridOrigin.current = { x, y }; });
                }}
                {...dragResponder.panHandlers}
              >
                <FlatList
                  ref={listRef}
                  data={assets}
                  numColumns={4}
                  keyExtractor={(asset) => asset.id}
                  initialNumToRender={32}
                  maxToRenderPerBatch={32}
                  windowSize={7}
                  onEndReached={loadMore}
                  onEndReachedThreshold={0.7}
                  onScroll={(event) => { scrollOffset.current = event.nativeEvent.contentOffset.y; }}
                  scrollEventThrottle={16}
                  ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footer} /> : null}
                  renderItem={({ item }) => {
                    const selectionIndex = selectedIds.indexOf(item.id);
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${item.filename}${selectionIndex >= 0 ? ` 選択順${selectionIndex + 1}` : ""}`}
                        onPress={() => toggleAsset(item.id)}
                        style={{ width: cellSize, height: cellSize, margin: 1 }}
                      >
                        <Image source={{ uri: item.uri }} style={styles.thumbnail} contentFit="cover" recyclingKey={item.id} />
                        {selectionIndex >= 0 && <View style={styles.badge}><Text style={styles.badgeText}>{selectionIndex + 1}</Text></View>}
                      </Pressable>
                    );
                  }}
                />
              </View>
            </SafeAreaView>
          </SafeAreaProvider>
        </Modal>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f4f7f6" },
  pickerSafeArea: { flex: 1, backgroundColor: "#fff" },
  centered: { flex: 1, alignItems: "center", justifyContent: "center" },
  loginContainer: { flex: 1, padding: 28, justifyContent: "center" },
  container: { flexGrow: 1, padding: 22, justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  title: { flex: 1, fontSize: 23, fontWeight: "800", color: "#173c33", marginBottom: 12 },
  logout: { color: "#b42318", fontSize: 14, marginBottom: 12 },
  description: { fontSize: 15, lineHeight: 23, color: "#42534f", marginBottom: 22 },
  passwordInput: { minHeight: 54, borderWidth: 1, borderColor: "#9caaa5", borderRadius: 10, backgroundColor: "#fff", paddingHorizontal: 16, fontSize: 17, marginBottom: 14 },
  openButton: { minHeight: 56, justifyContent: "center", backgroundColor: "#16745e", padding: 15, borderRadius: 12, alignItems: "center" },
  openButtonText: { color: "#fff", fontSize: 16, fontWeight: "700" },
  systemButton: { minHeight: 54, justifyContent: "center", borderWidth: 1, borderColor: "#16745e", backgroundColor: "#fff", padding: 14, borderRadius: 12, alignItems: "center", marginTop: 12 },
  systemButtonText: { color: "#16745e", fontSize: 16, fontWeight: "700" },
  buttonDisabled: { opacity: 0.5 },
  result: { marginTop: 22, padding: 18, borderRadius: 12, backgroundColor: "#fff" },
  resultTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12, color: "#173c33" },
  metric: { fontSize: 15, marginBottom: 7, color: "#1f2926" },
  note: { marginTop: 8, fontSize: 13, lineHeight: 20, color: "#60706c" },
  previewRow: { flexDirection: "row", gap: 5, marginTop: 10, marginBottom: 4 },
  previewItem: { flex: 1, minWidth: 0 },
  previewImage: { width: "100%", aspectRatio: 1, borderRadius: 5, backgroundColor: "#dce3e0" },
  previewStatus: { marginTop: 4, fontSize: 9, color: "#42534f", textAlign: "center" },
  compressionPanel: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#cbd6d2" },
  uploadPanel: { marginTop: 14, paddingTop: 14, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: "#cbd6d2" },
  progressHeader: { minHeight: 26, flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 10 },
  progressTitle: { flex: 1, fontSize: 16, fontWeight: "700", color: "#173c33", marginBottom: 8 },
  progressTrack: { height: 10, overflow: "hidden", borderRadius: 5, backgroundColor: "#dce6e2", marginBottom: 12 },
  progressFill: { height: "100%", borderRadius: 5, backgroundColor: "#16745e" },
  uploadFill: { height: "100%", borderRadius: 5, backgroundColor: "#1677d2" },
  cancelCompressionButton: { minHeight: 40, marginTop: 7, borderWidth: 1, borderColor: "#b42318", borderRadius: 8, alignItems: "center", justifyContent: "center" },
  cancelCompressionText: { color: "#b42318", fontSize: 14, fontWeight: "700" },
  sendButton: { minHeight: 52, marginTop: 15, backgroundColor: "#16745e", borderRadius: 10, alignItems: "center", justifyContent: "center", padding: 12 },
  deleteButton: { minHeight: 46, marginTop: 10, borderWidth: 1, borderColor: "#b42318", borderRadius: 9, alignItems: "center", justifyContent: "center", padding: 10 },
  deleteButtonText: { color: "#b42318", fontSize: 14, fontWeight: "700" },
  toolbar: { height: 54, paddingHorizontal: 16, flexDirection: "row", alignItems: "center", justifyContent: "space-between", borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: "#bbb" },
  grid: { flex: 1 },
  toolbarTitle: { fontSize: 17, fontWeight: "700" },
  cancel: { color: "#16745e", fontSize: 16 },
  done: { color: "#16745e", fontSize: 16, fontWeight: "700" },
  disabled: { opacity: 0.35 },
  thumbnail: { width: "100%", height: "100%", backgroundColor: "#ddd" },
  badge: { position: "absolute", top: 5, right: 5, width: 25, height: 25, borderRadius: 13, backgroundColor: "#1677d2", alignItems: "center", justifyContent: "center", borderWidth: 2, borderColor: "#fff" },
  badgeText: { color: "#fff", fontSize: 12, fontWeight: "800" },
  footer: { padding: 20 },
});
