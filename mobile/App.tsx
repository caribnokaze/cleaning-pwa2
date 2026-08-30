import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Platform, Pressable, SafeAreaView, ScrollView, StyleSheet, Text, View } from "react-native";
import FastPhotoPicker, {
  PhotoPreparationResult,
  PhotoPickerResult,
} from "./modules/fast-photo-picker/src";

export default function App() {
  const [result, setResult] = useState<PhotoPickerResult | null>(null);
  const [pickerName, setPickerName] = useState("");
  const [preparation, setPreparation] = useState<PhotoPreparationResult | null>(null);
  const [isPreparing, setIsPreparing] = useState(false);
  const [error, setError] = useState("");

  const openPicker = async (useSystemPicker: boolean) => {
    setError("");
    setPreparation(null);
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
  error: { marginTop: 20, color: "#b42318", fontSize: 15 },
});
