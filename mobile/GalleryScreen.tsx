import DateTimePicker, { DateTimePickerEvent } from "@react-native-community/datetimepicker";
import { Picker } from "@react-native-picker/picker";
import { useEffect, useMemo, useState } from "react";
import { Alert, Image, Modal, Platform, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from "react-native";
import FastPhotoPicker from "./modules/fast-photo-picker/src";

type ReportScope = "normal" | "special";
type GalleryReport = {
  date: string;
  site: string;
  staff: string;
  scope: ReportScope;
  photoIds: string[];
  filterMinutes?: string;
};
type GalleryPhoto = {
  key: string;
  date: string;
  site: string;
  staff: string;
  photoId: string;
  filename: string;
  url: string;
  downloadUrl?: string;
};

const CATEGORY_LABELS: Record<string, string> = {
  photos_amenity: "タオル・アメニティ・Wi-Fi・Netflix",
  photos_general: "その他全般",
  photos_kitchen: "キッチン",
  photos_bath: "お風呂・洗面・トイレ",
  photos_living: "リビング",
  photos_bedroom: "寝室",
  photos_hallway: "廊下",
  photos_equipment: "エアコン・照明・Wi-Fi・鍵",
  photos_others: "物件指定の清掃",
  regular_1: "定期清掃：リビング・共用スペース",
  regular_2: "定期清掃：寝室まわり",
  regular_3: "定期清掃：キッチン・ダイニング",
  regular_4: "定期清掃：浴室・洗面・トイレ",
  regular_5: "定期清掃：窓・建具",
  regular_6: "定期清掃：屋外・外周",
  regular_7: "定期清掃：場所横断",
  regular_8: "定期清掃：物件指定・その他",
  photos_filter: "フィルター清掃",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS);
const localDateString = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
};
const dateFromLocalString = (value: string) => {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, month - 1, day);
};
const localStringFromDate = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
const reportKey = (report: GalleryReport) => `${report.date}\u0000${report.site}\u0000${report.staff}\u0000${report.scope}`;
const categoryLabel = (photoId: string) => CATEGORY_LABELS[photoId] || photoId;

function FilterPicker({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (value: string) => void }) {
  const [visible, setVisible] = useState(false);
  const [pending, setPending] = useState(value);
  return <View style={styles.filter}>
    <Text style={styles.filterLabel}>{label}</Text>
    <Pressable style={styles.filterButton} onPress={() => { setPending(value); setVisible(true); }}>
      <Text numberOfLines={1} style={styles.filterButtonText}>{value || "すべて"}</Text><Text style={styles.filterChevron}>⌄</Text>
    </Pressable>
    <Modal visible={visible} transparent animationType="slide" onRequestClose={() => setVisible(false)}>
      <View style={styles.pickerOverlay}><View style={styles.pickerSheet}>
        <Text style={styles.pickerTitle}>{label}で絞り込み</Text>
        <Picker selectedValue={pending} onValueChange={(next) => setPending(String(next))} mode={Platform.OS === "android" ? "dropdown" : undefined}>
          <Picker.Item label="すべて" value="" />
          {options.map((option) => <Picker.Item key={option} label={option} value={option} />)}
        </Picker>
        <View style={styles.pickerActions}><Pressable style={styles.pickerCancel} onPress={() => setVisible(false)}><Text style={styles.linkText}>キャンセル</Text></Pressable><Pressable style={styles.pickerConfirm} onPress={() => { onChange(pending); setVisible(false); }}><Text style={styles.pickerConfirmText}>選択</Text></Pressable></View>
      </View></View>
    </Modal>
  </View>;
}

function workTypeLabel(report: GalleryReport) {
  if (report.scope === "normal") return "通常清掃";
  const hasRegular = report.photoIds.some((id) => id.startsWith("regular_"));
  const hasFilter = report.photoIds.includes("photos_filter");
  const filter = report.filterMinutes ? `フィルター清掃（${report.filterMinutes}分）` : "フィルター清掃";
  if (hasRegular && hasFilter) return `定期清掃＋${filter}`;
  if (hasRegular) return "定期清掃";
  return filter;
}

export default function GalleryScreen({
  apiUrl,
  authToken,
  onSessionExpired,
  onBusyChange,
}: {
  apiUrl: string;
  authToken: string;
  onSessionExpired: () => void;
  onBusyChange: (busy: boolean) => void;
}) {
  const [date, setDate] = useState(localDateString);
  const [datePickerVisible, setDatePickerVisible] = useState(false);
  const [reports, setReports] = useState<GalleryReport[]>([]);
  const [site, setSite] = useState("");
  const [staff, setStaff] = useState("");
  const [expanded, setExpanded] = useState("");
  const [photosByReport, setPhotosByReport] = useState<Record<string, GalleryPhoto[]>>({});
  const [loadingReport, setLoadingReport] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [modalPhotos, setModalPhotos] = useState<GalleryPhoto[]>([]);
  const [modalIndex, setModalIndex] = useState(0);
  const [selectionCategory, setSelectionCategory] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<string[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isAdding, setIsAdding] = useState(false);
  const [addingCategory, setAddingCategory] = useState("");
  const [addProgress, setAddProgress] = useState<{ completed: number; total: number } | null>(null);

  useEffect(() => {
    onBusyChange(isAdding || isDeleting);
    return () => onBusyChange(false);
  }, [isAdding, isDeleting, onBusyChange]);

  const request = async (path: string, init?: RequestInit) => {
    const response = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: { authorization: `Bearer ${authToken}`, ...(init?.headers || {}) },
    });
    if (response.status === 401) {
      onSessionExpired();
      throw new Error("ログインの有効期限が切れました。もう一度ログインしてください。");
    }
    return response;
  };

  const loadReports = async (showRefresh = false) => {
    if (showRefresh) setRefreshing(true);
    else setError("");
    try {
      const response = await request(`/api/reports?date=${encodeURIComponent(date)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body)) throw new Error(body.error || "写真一覧を読み込めませんでした");
      setReports(body);
      setPhotosByReport({});
      setExpanded("");
      setSite((current) => current && body.some((report: GalleryReport) => report.site === current) ? current : "");
      setStaff((current) => current && body.some((report: GalleryReport) => report.staff === current) ? current : "");
      setError("");
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setRefreshing(false);
    }
  };

  useEffect(() => { void loadReports(); }, [date, authToken]);

  const sites = useMemo(() => [...new Set(reports.map((report) => report.site))].sort((a, b) => a.localeCompare(b, "ja", { numeric: true })), [reports]);
  const staffMembers = useMemo(() => [...new Set(reports.map((report) => report.staff))].sort((a, b) => a.localeCompare(b, "ja", { numeric: true })), [reports]);
  const visibleReports = reports.filter((report) => (!site || report.site === site) && (!staff || report.staff === staff));

  const loadPhotos = async (report: GalleryReport, force = false) => {
    const key = reportKey(report);
    if (!force && photosByReport[key]) return;
    setLoadingReport(key);
    setError("");
    try {
      const params = new URLSearchParams({ date: report.date, site: report.site, staff: report.staff, scope: report.scope });
      const response = await request(`/api/photos?${params}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok || !Array.isArray(body)) throw new Error(body.error || "写真を読み込めませんでした");
      setPhotosByReport((current) => ({ ...current, [key]: body }));
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : String(loadError));
    } finally {
      setLoadingReport("");
    }
  };

  const toggleReport = async (report: GalleryReport) => {
    const key = reportKey(report);
    if (expanded === key) {
      setExpanded("");
      setSelectionCategory("");
      setSelectedKeys([]);
      return;
    }
    setExpanded(key);
    setSelectionCategory("");
    setSelectedKeys([]);
    await loadPhotos(report);
  };

  const addPhotos = async (report: GalleryReport, photoId: string) => {
    if (!FastPhotoPicker || isAdding) return;
    setError("");
    setIsAdding(true);
    setAddingCategory(`${reportKey(report)}\u0000${photoId}`);
    setAddProgress(null);
    try {
      const picked = await FastPhotoPicker.pickPhotos(30, `${categoryLabel(photoId)}へ追加`);
      if (!picked.assetIds.length) return;
      const timestamp = Date.now();
      const timeSuffix = photoId === "photos_filter" && report.filterMinutes ? `_${report.filterMinutes}min` : "";
      const files = picked.assetIds.map((_, index) => ({
        filename: `add_${timestamp}_${String(index + 1).padStart(3, "0")}${timeSuffix}.jpg`,
        contentType: "image/jpeg",
        photoId,
      }));
      const response = await request("/get-presigned-urls", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ date: report.date, site: report.site, staff: report.staff, files }),
      });
      const targets = await response.json();
      if (!response.ok || !Array.isArray(targets) || targets.length !== files.length) {
        throw new Error(targets.error || "写真追加の準備に失敗しました");
      }
      setAddProgress({ completed: 0, total: files.length });
      const subscription = FastPhotoPicker.addListener("onUploadProgress", ({ completedCount }) => {
        setAddProgress({ completed: completedCount, total: files.length });
      });
      try {
        const result = await FastPhotoPicker.prepareAndUploadPhotos(
          picked.assetIds,
          targets.map((target: { uploadUrl: string }) => target.uploadUrl),
          720,
          0.8,
          "none",
        );
        if (result.uploadedCount !== files.length || result.failedCount) throw new Error(result.firstError || "一部の写真を追加できませんでした");
      } finally {
        subscription.remove();
      }
      await loadPhotos(report, true);
      Alert.alert("写真を追加しました", `${files.length}枚を「${categoryLabel(photoId)}」へ追加しました。`);
    } catch (addError) {
      setError(addError instanceof Error ? addError.message : String(addError));
    } finally {
      setIsAdding(false);
      setAddingCategory("");
      setAddProgress(null);
    }
  };

  const deleteSelected = (report: GalleryReport) => {
    if (!selectedKeys.length || isDeleting) return;
    Alert.alert(
      "写真を削除しますか？",
      `選択した${selectedKeys.length}枚を削除します。この操作は元に戻せません。`,
      [
        { text: "キャンセル", style: "cancel" },
        { text: "削除", style: "destructive", onPress: () => void performDelete(report) },
      ],
    );
  };

  const performDelete = async (report: GalleryReport) => {
    setIsDeleting(true);
    setError("");
    try {
      const response = await request("/api/photos", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ keys: selectedKeys, confirmation: "削除" }),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || "写真を削除できませんでした");
      setSelectionCategory("");
      setSelectedKeys([]);
      await loadPhotos(report, true);
      Alert.alert("削除しました", `${body.deletedCount || 0}枚の写真を削除しました。`);
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : String(deleteError));
    } finally {
      setIsDeleting(false);
    }
  };

  const currentModalPhoto = modalPhotos[modalIndex];
  const changeModalPhoto = (offset: number) => {
    setModalIndex((current) => (current + offset + modalPhotos.length) % modalPhotos.length);
  };

  return <>
    <ScrollView
      contentContainerStyle={styles.container}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void loadReports(true)} tintColor="#16745e" />}
    >
      <Text style={styles.title}>清掃写真一覧</Text>
      <Text style={styles.description}>送信済みの写真を確認・追加・削除できます。</Text>
      <Text style={styles.filterLabel}>清掃日</Text>
      <Pressable style={styles.dateInput} onPress={() => setDatePickerVisible(true)}>
        <Text style={styles.dateText}>{date}</Text><Text>📅</Text>
      </Pressable>
      {datePickerVisible && <View style={Platform.OS === "ios" ? styles.iosDatePicker : undefined}>
        <DateTimePicker
          value={dateFromLocalString(date)}
          mode="date"
          display={Platform.OS === "ios" ? "spinner" : "default"}
          locale="ja-JP"
          onChange={(event: DateTimePickerEvent, nextDate?: Date) => {
            if (Platform.OS === "android") setDatePickerVisible(false);
            if (event.type === "set" && nextDate) setDate(localStringFromDate(nextDate));
          }}
        />
        {Platform.OS === "ios" && <Pressable style={styles.closePicker} onPress={() => setDatePickerVisible(false)}><Text style={styles.linkText}>閉じる</Text></Pressable>}
      </View>}
      <View style={styles.filterRow}>
        <FilterPicker label="現場" value={site} options={sites} onChange={setSite} />
        <FilterPicker label="担当者" value={staff} options={staffMembers} onChange={setStaff} />
      </View>
      <Text style={styles.summary}>{visibleReports.length}件の清掃報告</Text>
      {!visibleReports.length && !error && <Text style={styles.empty}>条件に一致する写真がありません。</Text>}
      {visibleReports.map((report) => {
        const key = reportKey(report);
        const photos = photosByReport[key] || [];
        const categories = [...new Set(photos.map((photo) => photo.photoId))].sort((a, b) => {
          const ai = CATEGORY_ORDER.indexOf(a), bi = CATEGORY_ORDER.indexOf(b);
          return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi);
        });
        return <View key={key} style={styles.reportCard}>
          <Pressable style={styles.reportHeader} onPress={() => void toggleReport(report)}>
            <Text style={styles.toggle}>{expanded === key ? "▲" : "▼"}</Text>
            <View style={styles.reportMeta}><Text style={styles.reportDate}>{report.date}</Text><Text style={styles.reportText}>🏠 {report.site}</Text><Text style={styles.reportText}>👤 {report.staff}</Text><Text style={styles.workType}>{workTypeLabel(report)}</Text></View>
          </Pressable>
          {expanded === key && loadingReport === key && <Text style={styles.empty}>写真を読み込んでいます…</Text>}
          {expanded === key && categories.map((photoId) => {
            const categoryPhotos = photos.filter((photo) => photo.photoId === photoId);
            const categoryKey = `${key}\u0000${photoId}`;
            const selecting = selectionCategory === categoryKey;
            return <View key={photoId} style={styles.category}>
              <Text style={styles.categoryTitle}>【{categoryLabel(photoId)}（{categoryPhotos.length}枚）】</Text>
              <View style={styles.actions}>
                <Pressable style={[styles.actionButton, isAdding && styles.disabled]} onPress={() => void addPhotos(report, photoId)} disabled={isAdding || isDeleting}><Text style={styles.actionText}>写真を追加</Text></Pressable>
                <Pressable style={styles.actionButton} onPress={() => { setSelectionCategory(selecting ? "" : categoryKey); setSelectedKeys([]); }} disabled={isAdding || isDeleting}><Text style={styles.deleteText}>{selecting ? "選択終了" : "選択して削除"}</Text></Pressable>
              </View>
              {addingCategory === categoryKey && addProgress && <Text style={styles.progress}>追加中 {addProgress.completed}/{addProgress.total}枚</Text>}
              <View style={styles.photoGrid}>{categoryPhotos.map((photo) => {
                const selected = selectedKeys.includes(photo.key);
                return <Pressable key={photo.key} style={[styles.photoCell, selected && styles.photoSelected]} onPress={() => {
                  if (selecting) setSelectedKeys((current) => selected ? current.filter((item) => item !== photo.key) : [...current, photo.key]);
                  else { setModalPhotos(categoryPhotos); setModalIndex(categoryPhotos.findIndex((item) => item.key === photo.key)); }
                }}><Image source={{ uri: photo.url }} style={styles.thumbnail} resizeMode="cover" />{selecting && <View style={[styles.check, selected && styles.checkSelected]}><Text style={styles.checkText}>{selected ? "✓" : ""}</Text></View>}</Pressable>;
              })}</View>
              {selecting && <Pressable style={[styles.confirmDelete, (!selectedKeys.length || isDeleting) && styles.disabled]} onPress={() => deleteSelected(report)} disabled={!selectedKeys.length || isDeleting}><Text style={styles.confirmDeleteText}>{isDeleting ? "削除中…" : `選択した写真を削除（${selectedKeys.length}枚）`}</Text></Pressable>}
            </View>;
          })}
        </View>;
      })}
      {!!error && <Text style={styles.error}>{error}</Text>}
    </ScrollView>
    <Modal visible={!!currentModalPhoto} transparent animationType="fade" onRequestClose={() => setModalPhotos([])}>
      <View style={styles.modal}>
        <View style={styles.modalHeader}><Text numberOfLines={2} style={styles.modalTitle}>{currentModalPhoto ? `${currentModalPhoto.date} / ${currentModalPhoto.site}\n${categoryLabel(currentModalPhoto.photoId)}` : ""}</Text><Pressable style={styles.modalClose} onPress={() => setModalPhotos([])}><Text style={styles.modalCloseText}>×</Text></Pressable></View>
        {currentModalPhoto && <Image source={{ uri: currentModalPhoto.url }} style={styles.fullImage} resizeMode="contain" />}
        <View style={styles.modalNavigation}><Pressable style={styles.modalButton} onPress={() => changeModalPhoto(-1)} disabled={modalPhotos.length < 2}><Text style={styles.modalButtonText}>‹ 前へ</Text></Pressable><Text style={styles.modalCount}>{modalIndex + 1} / {modalPhotos.length}</Text><Pressable style={styles.modalButton} onPress={() => changeModalPhoto(1)} disabled={modalPhotos.length < 2}><Text style={styles.modalButtonText}>次へ ›</Text></Pressable></View>
      </View>
    </Modal>
  </>;
}

const styles = StyleSheet.create({
  container: { padding: 16, paddingBottom: 60 }, title: { fontSize: 24, fontWeight: "900", color: "#173c33" }, description: { marginTop: 6, marginBottom: 16, color: "#60706c", lineHeight: 20 },
  filterLabel: { marginBottom: 6, color: "#294b42", fontWeight: "800" }, dateInput: { minHeight: 48, paddingHorizontal: 14, borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, backgroundColor: "#fff", flexDirection: "row", alignItems: "center" }, dateText: { flex: 1, fontSize: 16, color: "#1f312c" }, iosDatePicker: { marginTop: 8, borderWidth: 1, borderColor: "#d6dfdc", borderRadius: 10, backgroundColor: "#fff", overflow: "hidden" }, closePicker: { alignSelf: "flex-end", padding: 14 }, linkText: { color: "#16745e", fontWeight: "800" },
  filterRow: { flexDirection: "row", gap: 10, marginTop: 14 }, filter: { flex: 1 }, filterButton: { minHeight: 48, paddingHorizontal: 11, borderWidth: 1, borderColor: "#aebcb7", borderRadius: 10, backgroundColor: "#fff", flexDirection: "row", alignItems: "center" }, filterButtonText: { flex: 1, color: "#1f312c", fontSize: 15 }, filterChevron: { color: "#16745e", fontSize: 23, fontWeight: "800", transform: [{ translateY: -3 }] }, pickerOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.35)" }, pickerSheet: { backgroundColor: "#fff", borderTopLeftRadius: 18, borderTopRightRadius: 18, paddingTop: 18, paddingHorizontal: 18, paddingBottom: 28 }, pickerTitle: { color: "#173c33", fontSize: 18, fontWeight: "900", textAlign: "center" }, pickerActions: { flexDirection: "row", gap: 10, marginTop: 8 }, pickerCancel: { flex: 1, minHeight: 48, borderWidth: 1, borderColor: "#16745e", borderRadius: 10, alignItems: "center", justifyContent: "center" }, pickerConfirm: { flex: 1, minHeight: 48, borderRadius: 10, backgroundColor: "#16745e", alignItems: "center", justifyContent: "center" }, pickerConfirmText: { color: "#fff", fontWeight: "800" }, summary: { marginVertical: 16, color: "#60706c", fontWeight: "700" }, empty: { padding: 18, textAlign: "center", color: "#60706c" },
  reportCard: { marginBottom: 14, borderWidth: 1, borderColor: "#d6dfdc", borderRadius: 12, backgroundColor: "#fff", overflow: "hidden" }, reportHeader: { flexDirection: "row", padding: 14, backgroundColor: "#e8f3ef" }, toggle: { width: 32, height: 32, paddingTop: 7, borderWidth: 1, borderColor: "#16745e", borderRadius: 16, textAlign: "center", color: "#12634f", fontSize: 12 }, reportMeta: { flex: 1, paddingLeft: 12, gap: 3 }, reportDate: { color: "#173c33", fontSize: 18, fontWeight: "900" }, reportText: { color: "#344640", fontSize: 14, fontWeight: "700" }, workType: { marginTop: 3, color: "#12634f", fontWeight: "800" },
  category: { padding: 12, borderTopWidth: 1, borderTopColor: "#e7ecea" }, categoryTitle: { color: "#253d37", fontSize: 14, fontWeight: "900", lineHeight: 20 }, actions: { flexDirection: "row", gap: 8, marginVertical: 10 }, actionButton: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: "#16745e", borderRadius: 8, alignItems: "center", justifyContent: "center", paddingHorizontal: 6 }, actionText: { color: "#16745e", fontWeight: "800", fontSize: 13 }, deleteText: { color: "#a1261d", fontWeight: "800", fontSize: 13 }, disabled: { opacity: 0.4 }, progress: { marginBottom: 9, textAlign: "center", color: "#12634f", fontWeight: "800" },
  photoGrid: { flexDirection: "row", flexWrap: "wrap", gap: 6 }, photoCell: { width: "31.8%", aspectRatio: 1, borderRadius: 7, overflow: "hidden", borderWidth: 2, borderColor: "transparent" }, photoSelected: { borderColor: "#16745e" }, thumbnail: { width: "100%", height: "100%", backgroundColor: "#e6ecea" }, check: { position: "absolute", top: 5, right: 5, width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: "#fff", backgroundColor: "rgba(0,0,0,0.35)", alignItems: "center", justifyContent: "center" }, checkSelected: { backgroundColor: "#16745e" }, checkText: { color: "#fff", fontWeight: "900" }, confirmDelete: { marginTop: 10, minHeight: 44, borderRadius: 8, backgroundColor: "#a1261d", alignItems: "center", justifyContent: "center" }, confirmDeleteText: { color: "#fff", fontWeight: "900" }, error: { marginTop: 16, color: "#b42318", lineHeight: 20 },
  modal: { flex: 1, backgroundColor: "rgba(0,0,0,0.94)", paddingTop: Platform.OS === "ios" ? 48 : 16 }, modalHeader: { minHeight: 62, flexDirection: "row", alignItems: "center", paddingHorizontal: 14 }, modalTitle: { flex: 1, color: "#fff", lineHeight: 20 }, modalClose: { width: 44, height: 44, alignItems: "center", justifyContent: "center" }, modalCloseText: { color: "#fff", fontSize: 34 }, fullImage: { flex: 1, width: "100%" }, modalNavigation: { minHeight: 76, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 18, paddingBottom: Platform.OS === "ios" ? 16 : 0 }, modalButton: { minWidth: 88, minHeight: 44, alignItems: "center", justifyContent: "center" }, modalButtonText: { color: "#fff", fontSize: 16, fontWeight: "800" }, modalCount: { color: "#fff", fontWeight: "800" },
});
