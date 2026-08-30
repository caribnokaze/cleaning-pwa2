import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import {
  Platform,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import FastPhotoPicker, {
  PhotoPreparationResult,
  PhotoPickerResult,
  PhotoUploadResult,
} from "./modules/fast-photo-picker/src";

const STAGING_API_URL =
  "https://biosdhdwobbnfvv4i2xbrw2vfm0kstgg.lambda-url.ap-northeast-1.on.aws";

type StagingUploadResult = PhotoUploadResult & { deletedCount: number };

export default function App() {
  const [result, setResult] = useState<PhotoPickerResult | null>(null);
  const [pickerName, setPickerName] = useState("");
  const [preparation, setPreparation] = useState<PhotoPreparationResult | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [stagingPassword, setStagingPassword] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [uploadPhase, setUploadPhase] = useState("");
  const [uploadResult, setUploadResult] = useState<StagingUploadResult | null>(null);
  const [error, setError] = useState("");

  const openPicker = async (useSystemPicker: boolean) => {
    setError("");
    setPreparation(null);
    setUploadResult(null);
    setUploadPhase("");
    if (Platform.OS !== "ios" || !FastPhotoPicker) {
      setError("この試作版の高速写真選択はiPhone実機用です。");
      return;
    }
    try {
      const nextResult = useSystemPicker
        ? await FastPhotoPicker.pickPhotosWithSystemPicker(100)
        : await FastPhotoPicker.pickPhotos(100);
      setPickerName(useSystemPicker ? "Apple標準ピッカー" : "独自高速ピッカー");
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
    setError("");
    setUploadResult(null);
    setIsUploading(true);
    setUploadPhase("検証環境へログイン中…");
    const runId = `ios-${Date.now()}`;
    let token = "";
    let cleanupCompleted = false;
    let nativeResult: PhotoUploadResult | null = null;
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
          body: JSON.stringify({ runId, files }),
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
      );

      setUploadPhase("検証S3からテスト写真を削除中…");
      const deleteResponse = await fetch(
        `${STAGING_API_URL}/api/mobile-test/runs/${runId}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
      );
      const deleteBody = await deleteResponse.json();
      if (!deleteResponse.ok) {
        throw new Error(deleteBody.error || "検証写真を削除できませんでした");
      }
      cleanupCompleted = true;
      setUploadResult({ ...nativeResult, deletedCount: deleteBody.deletedCount });
      setStagingPassword("");
      setUploadPhase("完了（検証写真は削除済み）");
    } catch (uploadError) {
      setError(uploadError instanceof Error ? uploadError.message : String(uploadError));
    } finally {
      if (token && !cleanupCompleted) {
        setUploadPhase("エラー後のテスト写真を削除中…");
        try {
          const cleanupResponse = await fetch(
            `${STAGING_API_URL}/api/mobile-test/runs/${runId}`,
            { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
          );
          cleanupCompleted = cleanupResponse.ok;
        } catch {
          cleanupCompleted = false;
        }
        setUploadPhase(
          cleanupCompleted
            ? "エラー終了（送信済み写真は削除済み）"
            : "エラー終了（自動削除は1日後）",
        );
      }
      setIsUploading(false);
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <ScrollView contentContainerStyle={styles.container}>
        <Text style={styles.title}>TOCORO. 写真選択テスト</Text>
        <Text style={styles.description}>
          写真本体を読み込む前に、PhotoKitの写真IDだけを選択します。
          Apple標準版と独自版で、操作性と100枚選択後の復帰時間を比較してください。
        </Text>

        <Pressable style={styles.button} onPress={() => openPicker(true)}>
          <Text style={styles.buttonText}>Apple標準ピッカー（最大100枚）</Text>
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
              実運用フロー：選択した写真を1回だけ準備し、検証専用S3へ送信して直後に削除します。
            </Text>
            <TextInput
              style={styles.passwordInput}
              value={stagingPassword}
              onChangeText={setStagingPassword}
              placeholder="検証環境のパスワード"
              secureTextEntry
              autoCapitalize="none"
              autoCorrect={false}
              editable={!isUploading}
            />
            <Pressable
              style={[styles.button, styles.benchmarkButton, isUploading && styles.disabledButton]}
              onPress={uploadToStaging}
              disabled={isUploading || !stagingPassword || result.assetIds.length === 0}
            >
              <Text style={styles.buttonText}>
                {isUploading ? "実送信処理中…" : "選択写真を検証S3へ実送信"}
              </Text>
            </Pressable>
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
                <Text style={styles.metric}>検証S3から削除：{uploadResult.deletedCount}枚</Text>
                {!!uploadResult.firstError && (
                  <Text style={styles.error}>{uploadResult.firstError}</Text>
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
  phase: { marginTop: 12, color: "#36564e", fontSize: 15, textAlign: "center" },
  error: { marginTop: 20, color: "#b42318", fontSize: 15 },
});
