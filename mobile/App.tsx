import { StatusBar } from "expo-status-bar";
import { useState } from "react";
import { Platform, Pressable, SafeAreaView, StyleSheet, Text, View } from "react-native";
import FastPhotoPicker, {
  PhotoPickerResult,
} from "./modules/fast-photo-picker/src";

export default function App() {
  const [result, setResult] = useState<PhotoPickerResult | null>(null);
  const [error, setError] = useState("");

  const openPicker = async () => {
    setError("");
    if (Platform.OS !== "ios" || !FastPhotoPicker) {
      setError("この試作版の高速写真選択はiPhone実機用です。");
      return;
    }
    try {
      setResult(await FastPhotoPicker.pickPhotos(100));
    } catch (pickerError) {
      setError(pickerError instanceof Error ? pickerError.message : String(pickerError));
    }
  };

  return (
    <SafeAreaView style={styles.safeArea}>
      <StatusBar style="dark" />
      <View style={styles.container}>
        <Text style={styles.title}>TOCORO. 写真選択テスト</Text>
        <Text style={styles.description}>
          写真本体を読み込む前に、PhotoKitの写真IDだけを選択します。
          5枚と100枚で「完了」を押してから戻る時間を比較してください。
        </Text>

        <Pressable style={styles.button} onPress={openPicker}>
          <Text style={styles.buttonText}>写真を選択（最大100枚）</Text>
        </Pressable>

        {result && (
          <View style={styles.result}>
            <Text style={styles.resultTitle}>選択結果</Text>
            <Text style={styles.metric}>選択枚数：{result.assetIds.length}枚</Text>
            <Text style={styles.metric}>画面復帰：約{result.dismissalMs}ms</Text>
            <Text style={styles.note}>
              この段階では元画像を読み込んでいません。次の実装で画面復帰後に準備・アップロードします。
            </Text>
          </View>
        )}
        {!!error && <Text style={styles.error}>{error}</Text>}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: "#f4f7f6" },
  container: { flex: 1, padding: 24, justifyContent: "center" },
  title: { fontSize: 25, fontWeight: "800", color: "#173c33", marginBottom: 14 },
  description: { fontSize: 16, lineHeight: 25, color: "#42534f", marginBottom: 28 },
  button: { backgroundColor: "#16745e", padding: 17, borderRadius: 12, alignItems: "center" },
  buttonText: { color: "#fff", fontSize: 17, fontWeight: "700" },
  result: { marginTop: 28, padding: 20, borderRadius: 12, backgroundColor: "#fff" },
  resultTitle: { fontSize: 18, fontWeight: "800", marginBottom: 12, color: "#173c33" },
  metric: { fontSize: 17, marginBottom: 8, color: "#1f2926" },
  note: { marginTop: 8, fontSize: 14, lineHeight: 21, color: "#60706c" },
  error: { marginTop: 20, color: "#b42318", fontSize: 15 },
});
