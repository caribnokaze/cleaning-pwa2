/**
 * 1. ページ読み込み時の初期設定
 */
window.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) dateInput.valueAsDate = new Date();
  
  // 初期状態の反映
  toggleInputsByWorkType();
  updateButtonState();

  // ラジオボタンの変更イベントを個別に登録（確実性を高めるため）
  document.querySelectorAll('input[name="workType"]').forEach(radio => {
    radio.addEventListener('change', () => {
      toggleInputsByWorkType();
      updateButtonState();
    });
  });
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
  if (!workType) return;

  const normalIds = ['photos_amenity', 'photos_kitchen', 'photos_toilet', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_hallway', 'photos_others'];
  const regularIds = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7', 'regular_8'];
  const filterIds = ['photos_filter', 'workTime'];

  const setEnable = (ids, enabled) => {
    ids.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !enabled;
        // input自体の透明度だけでなく、親要素(label等)も含めて視覚的に無効化
        el.style.opacity = enabled ? "1" : "0.5";
        if (el.parentElement) el.parentElement.style.opacity = enabled ? "1" : "0.5";
        if (!enabled) el.value = ""; 
      }
    });
  };

  // 通常清掃は常に有効
  setEnable(normalIds, true);

  // モード別の有効化
  setEnable(regularIds, (workType === 'regular' || workType === 'full'));
  setEnable(filterIds, (workType === 'filter' || workType === 'full'));
}

/**
 * 4. メイン送信関数
 */
async function send() {
  const btn = document.getElementById("submitBtn");
  
  // 画面ロック
  const lockLayer = document.createElement("div");
  lockLayer.id = "screen-lock";
  Object.assign(lockLayer.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(0,0,0,0.2)", zIndex: "9999", cursor: "wait"
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
      { id: 'photos_amenity', label: 'タオル歯ブラシ', category: 'normal' },
      { id: 'photos_kitchen', label: 'キッチン', category: 'normal' },
      { id: 'photos_toilet', label: 'トイレ', category: 'normal' },
      { id: 'photos_bath', label: 'お風呂洗面', category: 'normal' },
      { id: 'photos_living', label: 'リビング', category: 'normal' },
      { id: 'photos_bedroom', label: '寝室', category: 'normal' },
      { id: 'photos_hallway', label: '廊下', category: 'normal' },
      { id: 'photos_others', label: '物件指定破損', category: 'normal' },
      { id: 'regular_1', label: '定期_リビング', category: 'regular' },
      { id: 'regular_2', label: '定期_寝室', category: 'regular' },
      { id: 'regular_3', label: '定期_キッチン', category: 'regular' },
      { id: 'regular_4', label: '定期_水回り', category: 'regular' },
      { id: 'regular_5', label: '定期_窓建具', category: 'regular' },
      { id: 'regular_6', label: '定期_屋外', category: 'regular' },
      { id: 'regular_7', label: '定期_場所横断', category: 'regular' },
      { id: 'regular_8', label: '定期_その他', category: 'regular' },
      { id: 'photos_filter', label: 'フィルター', category: 'filter' }
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
        
        // isExtra判定: カテゴリが'normal'でなければtrue
        const isExtra = inputInfo.category !== 'normal';

        allImages.push({
          id: inputInfo.id,
          label: inputInfo.label,
          data: compressed,
          isExtra: isExtra
        });
      }
    }

    btn.innerText = `データを送信中...`;
    
// --- App.js 修正版 ---

btn.innerText = `データをサーバーへ送信中...`;

// ループはさせず、1回の fetch で全データを送る
const response = await fetch("/upload", {
  method: "POST",
  headers: {
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    staff,
    site,
    reportDate,
    workTypeLabel: workTypeLabels[workType],
    workTime: workTime || "0",
    allImages: allImages // 圧縮済みの全画像が入った配列を渡す
  })
});

if (!response.ok) throw new Error("サーバーへの送信に失敗しました");

// サーバーがデータを受け取った時点で「送信完了」とする
btn.innerText = "送信完了！(裏側で保存中)";
btn.style.background = "#28a745";
setTimeout(() => location.reload(), 2000);

    btn.innerText = "送信完了！";
    btn.style.background = "#28a745";
    setTimeout(() => location.reload(), 2000);

  } catch (e) {
    console.error(e);
    alert("エラーが発生しました。");
    btn.disabled = false;
    btn.innerText = "送信";
    if (document.getElementById("screen-lock")) document.getElementById("screen-lock").remove();
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
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);
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
  const staff = document.getElementById("staff")?.value.trim();
  const site = document.getElementById("site")?.value.trim();
  const reportDate = document.getElementById("reportDate")?.value;
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  const workTime = document.getElementById("workTime")?.value;

  const normalIds = ['photos_amenity', 'photos_kitchen', 'photos_toilet', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_hallway'];
  const regularIds = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7', 'regular_8'];

  const hasNormal = normalIds.some(id => (document.getElementById(id)?.files?.length || 0) > 0);
  const hasRegular = regularIds.some(id => (document.getElementById(id)?.files?.length || 0) > 0);
  const hasFilter = (document.getElementById('photos_filter')?.files?.length || 0) > 0;

  let isValid = false;

  if (staff && site && reportDate) {
    // 全てのモードで「通常清掃」のいずれかの写真があることを必須とする
    if (workType === 'normal') {
      isValid = hasNormal;
    } else if (workType === 'regular') {
      isValid = hasNormal && hasRegular;
    } else if (workType === 'filter') {
      isValid = hasNormal && hasFilter && workTime;
    } else if (workType === 'full') {
      isValid = hasNormal && hasRegular && hasFilter && workTime;
    }
  }

  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = !isValid;
    btn.style.opacity = isValid ? "1" : "0.5";
    btn.style.cursor = isValid ? "pointer" : "not-allowed";
  }
}

/**
 * 7. イベント設定
 */
document.addEventListener('change', (e) => {
  // ファイル枚数制限
  if (e.target.type === 'file') {
    const limit = FILE_LIMITS[e.target.id];
    if (limit && e.target.files.length > limit) {
      alert(`最大${limit}枚までです。`);
      e.target.value = "";
    }
  }
  updateButtonState();
});

// 入力フィールドの監視
['staff', 'site', 'reportDate', 'workTime'].forEach(id => {
  const el = document.getElementById(id);
  if (el) el.addEventListener('input', updateButtonState);
});
