/**
 * 1. ページ読み込み時の初期設定
 */
window.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) dateInput.valueAsDate = new Date();
  updateButtonState();
});

/**
 * 2. 各項目ごとの枚数制限設定
 * HTMLのラベルに記載された制限枚数とIDを紐付けます
 */
const FILE_LIMITS = {
  // 通常清掃
  'photos_amenity': 5,
  'photos_kitchen': 15,
  'photos_toilet': 10,
  'photos_bath': 15,
  'photos_living': 15,
  'photos_bedroom': 15,
  'photos_hallway': 15,
  'photos_others': 10,
  // 定期清掃
  'regular_1': 10,
  'regular_2': 10,
  'regular_3': 10,
  'regular_4': 10,
  'regular_5': 10,
  'regular_6': 10,
  'regular_7': 10,
  'regular_8': 10,
  // フィルター
  'photos_filter': 10
};

/**
 * 3. メイン送信関数
 */
async function send() {
  const btn = document.getElementById("submitBtn");
  let isSuccess = false;

  const lockLayer = document.createElement("div");
  lockLayer.id = "screen-lock";
  Object.assign(lockLayer.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(0,0,0,0.1)", zIndex: "9999", cursor: "not-allowed"
  });
  document.body.appendChild(lockLayer);

  try {
    const staff = document.getElementById("staff").value;
    const site = document.getElementById("site").value;
    const reportDate = document.getElementById("reportDate").value;
    const workType = document.querySelector('input[name="workType"]:checked')?.value || "";
    const workTime = document.getElementById("workTime").value;

    const workTypeLabels = {
      normal: "通常清掃のみ", full: "定期清掃＋フィルター清掃",
      regular: "定期清掃のみ", filter: "フィルター清掃のみ"
    };

    const fileInputs = [
      { id: 'photos_amenity', label: 'タオル歯ブラシ' },
      { id: 'photos_kitchen', label: 'キッチン' },
      { id: 'photos_toilet', label: 'トイレ' },
      { id: 'photos_bath', label: 'お風呂洗面' },
      { id: 'photos_living', label: 'リビング' },
      { id: 'photos_bedroom', label: '寝室' },
      { id: 'photos_hallway', label: '廊下' },
      { id: 'photos_others', label: '物件指定破損' },
      { id: 'regular_1', label: '定期_リビング' },
      { id: 'regular_2', label: '定期_寝室' },
      { id: 'regular_3', label: '定期_キッチン' },
      { id: 'regular_4', label: '定期_水回り' },
      { id: 'regular_5', label: '定期_窓建具' },
      { id: 'regular_6', label: '定期_屋外' },
      { id: 'regular_7', label: '定期_場所横断' },
      { id: 'regular_8', label: '定期_その他' },
      { id: 'photos_filter', label: 'フィルター' }
    ];

    btn.disabled = true;
    btn.innerText = "画像を圧縮中...";

    const allImages = [];
    let processedCount = 0;

    for (const inputInfo of fileInputs) {
      const inputEl = document.getElementById(inputInfo.id);
      if (!inputEl || !inputEl.files.length) continue;

      const files = Array.from(inputEl.files);
      for (let i = 0; i < files.length; i++) {
        const compressed = await compressToBase64(files[i], 800, 0.3);
        allImages.push({
          name: `${site}_(${reportDate})_${staff}_[${inputInfo.label}]_${i + 1}`,
          data: compressed
        });
        processedCount++;
        btn.innerText = `圧縮中 (${processedCount}枚完了)`;
      }
    }

    btn.innerText = `データを送信中...`;
    const response = await fetch("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        staff, site, reportDate,
        workTypeLabel: workTypeLabels[workType],
        workTime: (workType === 'full' || workType === 'filter') ? workTime : "0",
        allImages
      })
    });

    if (!response.ok) throw new Error("送信失敗");

    isSuccess = true;
    btn.innerText = "送信完了！";
    btn.style.background = "#28a745";
    setTimeout(() => location.reload(), 3000);

  } catch (e) {
    console.error(e);
    alert("エラーが発生しました。");
    btn.disabled = false;
    btn.innerText = "送信";
  } finally {
    if (!isSuccess) lockLayer.remove();
  }
}

/**
 * 4. 画像圧縮
 */
function compressToBase64(file, maxWidth, quality) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        let { width, height } = img;
        if (width > maxWidth) {
          height = Math.round(height * maxWidth / width);
          width = maxWidth;
        }
        canvas.width = width;
        canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/**
 * 5. 送信ボタン制御
 */
function updateButtonState() {
  const staff = document.getElementById("staff").value;
  const site = document.getElementById("site").value;
  const reportDate = document.getElementById("reportDate").value;
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  const workTime = document.getElementById("workTime").value;

  // バリデーション用：必須項目に写真が入っているかチェック
  const hasNormalPhotos = ['photos_amenity', 'photos_kitchen', 'photos_toilet', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_hallway'].some(id => document.getElementById(id).files.length > 0);
  const hasRegularPhotos = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7'].some(id => document.getElementById(id).files.length > 0);
  const hasFilterPhotos = document.getElementById('photos_filter').files.length > 0;

  let isValid = false;
  if (staff && site && reportDate) {
    if (workType === 'normal') isValid = hasNormalPhotos;
    else if (workType === 'regular') isValid = hasRegularPhotos;
    else if (workType === 'filter') isValid = hasFilterPhotos && workTime;
    else if (workType === 'full') isValid = hasRegularPhotos && hasFilterPhotos && workTime;
  }

  const btn = document.getElementById("submitBtn");
  btn.disabled = !isValid;
  btn.style.opacity = isValid ? "1" : "0.5";
}

/**
 * 6. イベント設定（枚数制限チェック含む）
 */
document.addEventListener('change', (e) => {
  // ファイル入力の場合
  if (e.target.type === 'file') {
    const id = e.target.id;
    const limit = FILE_LIMITS[id];
    
    if (limit && e.target.files.length > limit) {
      alert(`この項目は最大${limit}枚までです。選択し直してください。`);
      e.target.value = ""; // 選択をリセット
    }
  }
  updateButtonState();
});

// その他の入力監視
['staff', 'site', 'reportDate', 'workTime'].forEach(id => {
  document.getElementById(id).addEventListener('input', updateButtonState);
});
