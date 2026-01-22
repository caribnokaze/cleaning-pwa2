/**
 * 1. ページ読み込み時の初期設定
 */
window.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) dateInput.valueAsDate = new Date();
  
  toggleInputsByWorkType();
  updateButtonState();
});

/**
 * 2. 枚数制限設定
 */
const FILE_LIMITS = {
  'photos_amenity': 5, 'photos_kitchen': 15, 'photos_toilet': 10,
  'photos_bath': 15, 'photos_living': 15, 'photos_bedroom': 15,
  'photos_hallway': 15, 'photos_others': 10,
  'regular_1': 10, 'regular_2': 10, 'regular_3': 10, 'regular_4': 10,
  'regular_5': 10, 'regular_6': 10, 'regular_7': 10, 'regular_8': 10,
  'photos_filter': 10
};

/**
 * 3. 入力項目の有効・無効切り替え
 */
function toggleInputsByWorkType() {
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  
  const normalIds = ['photos_amenity', 'photos_kitchen', 'photos_toilet', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_hallway', 'photos_others'];
  const regularIds = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7', 'regular_8'];
  const filterIds = ['photos_filter', 'workTime'];

  const setEnable = (ids, enabled) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !enabled;
        el.style.opacity = enabled ? "1" : "0.3";
        if (!enabled) el.value = ""; 
      }
    });
  };

  // 通常清掃（normalIds）はどの区分でも常に「true（有効）」にします
  setEnable(normalIds, true);

  if (workType === 'normal') {
    setEnable(regularIds, false);
    setEnable(filterIds, false);
  } 
  else if (workType === 'regular') {
    setEnable(regularIds, true);
    setEnable(filterIds, false);
  } 
  else if (workType === 'filter') {
    setEnable(regularIds, false);
    setEnable(filterIds, true);
  } 
  else if (workType === 'full') {
    setEnable(regularIds, true);
    setEnable(filterIds, true);
  }
}

/**
 * 4. メイン送信関数
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
    for (const inputInfo of fileInputs) {
      const inputEl = document.getElementById(inputInfo.id);
      if (!inputEl || inputEl.disabled || !inputEl.files.length) continue;

      const files = Array.from(inputEl.files);
      for (let i = 0; i < files.length; i++) {
        const compressed = await compressToBase64(files[i], 800, 0.3);
        allImages.push({
          name: `${site}_(${reportDate})_${staff}_[${inputInfo.label}]_${i + 1}`,
          data: compressed
        });
      }
    }

    btn.innerText = `データを送信中...`;
    const response = await fetch("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        staff, site, reportDate,
        workTypeLabel: workTypeLabels[workType],
        workTime: workTime || "0",
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
    lockLayer.remove();
  }
}

/**
 * 5. 画像圧縮
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
 * 6. バリデーション（ボタン活性化条件）
 */
function updateButtonState() {
  const staff = document.getElementById("staff").value;
  const site = document.getElementById("site").value;
  const reportDate = document.getElementById("reportDate").value;
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  const workTime = document.getElementById("workTime").value;

  const hasNormal = ['photos_amenity', 'photos_kitchen', 'photos_toilet', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_hallway'].some(id => document.getElementById(id).files.length > 0);
  const hasRegular = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7'].some(id => document.getElementById(id).files.length > 0);
  const hasFilter = document.getElementById('photos_filter').files.length > 0;

  let isValid = false;
  if (staff && site && reportDate) {
    // どのモードでも「通常写真」があれば送信可能とする（運用に合わせて調整可）
    if (workType === 'normal') {
      isValid = hasNormal;
    } else if (workType === 'regular') {
      isValid = hasRegular; // 定期モードなら定期写真が必須
    } else if (workType === 'filter') {
      isValid = hasFilter && workTime; // フィルターモードならフィルター写真と時間が必須
    } else if (workType === 'full') {
      isValid = hasRegular && hasFilter && workTime;
    }
  }

  const btn = document.getElementById("submitBtn");
  btn.disabled = !isValid;
  btn.style.opacity = isValid ? "1" : "0.5";
}

/**
 * 7. イベント設定
 */
document.addEventListener('change', (e) => {
  if (e.target.name === 'workType') {
    toggleInputsByWorkType();
  }
  
  if (e.target.type === 'file') {
    const limit = FILE_LIMITS[e.target.id];
    if (limit && e.target.files.length > limit) {
      alert(`最大${limit}枚までです。`);
      e.target.value = "";
    }
  }
  updateButtonState();
});

['staff', 'site', 'reportDate', 'workTime'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateButtonState);
});
