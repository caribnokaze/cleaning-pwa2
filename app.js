/**
 * 1. ページ読み込み時の初期設定
 */
window.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) {
    const today = new Date().toISOString().split('T')[0];
    dateInput.value = today;
  }
  
  toggleInputsByWorkType();
  updateButtonState();

  // ラジオボタンの監視
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
  'photos_amenity': 5, 'photos_kitchen': 15,
  'photos_bath': 15, 'photos_living': 15, 'photos_bedroom': 15,
  'photos_hallway': 15, 'photos_equipment': 10, 'photos_others': 10,
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

  const regularAreas = ['area_regular'];
  const filterAreas = ['area_filter_photo', 'area_workTime'];
  const regularInputs = ['regular_1', 'regular_2', 'regular_3', 'regular_4', 'regular_5', 'regular_6', 'regular_7', 'regular_8'];
  const filterInputs = ['photos_filter', 'workTime'];

  const updateUI = (areaIds, inputIds, enabled) => {
    areaIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.style.opacity = enabled ? "1" : "0.5";
    });
    inputIds.forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !enabled;
        if (!enabled) el.value = ""; 
      }
    });
  };

  const areaNormal = document.getElementById('area_normal');
  if (areaNormal) areaNormal.style.opacity = "1";

  const isRegularActive = (workType === 'regular' || workType === 'full');
  const isFilterActive = (workType === 'filter' || workType === 'full');

  updateUI(regularAreas, regularInputs, isRegularActive);
  updateUI(filterAreas, filterInputs, isFilterActive);
}



/**
 * 4. メイン送信関数 (Android SH-51C 救済モデル)
 */
async function send() {
  const btn = document.getElementById("submitBtn");
  if (btn.disabled) return;

  // --- 1. 入力値の取得 ---
  const staff = document.getElementById("staff").value;
  const site = document.getElementById("site").value;
  const reportDate = document.getElementById("reportDate").value;
  const workType = document.querySelector('input[name="workType"]:checked')?.value || "";
  const workTime = document.getElementById("workTime").value;

  const workTypeLabels = {
    normal: "通常清掃のみ",
    full: "定期清掃＋フィルター清掃",
    regular: "定期清掃のみ",
    filter: "フィルター清掃のみ"
  };

  // --- 2. 確認ダイアログ ---
  if (!confirm("送信を開始します。よろしいですか？\n(送信中は画面を閉じないでください)")) return;

  // --- 3. 進捗表示レイヤーの作成 ---
  const lockLayer = document.createElement("div");
  lockLayer.id = "screen-lock";
  Object.assign(lockLayer.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(0,0,0,0.7)", zIndex: "9999", color: "white",
    display: "flex", flexDirection: "column", justifyContent: "center", alignItems: "center", textAlign: "center"
  });
  lockLayer.innerHTML = `
    <div style="width: 80%;">
      <div id="progress-text" style="font-size: 18px; margin-bottom: 15px;">準備中...</div>
      <div style="width:100%; height:15px; background:#444; border-radius:10px; overflow:hidden;">
        <div id="progress-bar" style="width:0%; height:100%; background:#28a745; transition:0.3s;"></div>
      </div>
      <p style="font-size: 12px; margin-top: 20px;">サーバーへ転送中です。<br>数字が最後まで進めば移動してOKです！</p>
    </div>
  `;
  document.body.appendChild(lockLayer);

  const progText = document.getElementById("progress-text");
  const progBar = document.getElementById("progress-bar");

  try {
    const fileInputs = [
      { id: 'photos_amenity', label: 'タオル/歯ブラシ' },
      { id: 'photos_kitchen', label: 'キッチン' },
      { id: 'photos_bath', label: 'お風呂/洗面/トイレ' },
      { id: 'photos_living', label: 'リビング' },
      { id: 'photos_bedroom', label: '寝室' },
      { id: 'photos_hallway', label: '廊下' },
      { id: 'photos_equipment', label: 'エアコン/電気/WiFi/鍵' },
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

    // 全ファイルリストの作成
    let tasks = [];
    fileInputs.forEach(input => {
      const el = document.getElementById(input.id);
      if (el && !el.disabled && el.files.length) {
        Array.from(el.files).forEach(f => tasks.push({ file: f, label: input.label, id: input.id }));
      }
    });

    const total = tasks.length;
    btn.disabled = true;

    // --- 4. 1枚ずつ 圧縮 → 送信 を繰り返す ---
    for (let i = 0; i < total; i++) {
      const current = i + 1;
      progText.innerText = `送信中: ${current} / ${total} 枚目\n(${tasks[i].label})`;
      progBar.style.width = `${(current / total) * 100}%`;

      // 軽量サイズで圧縮 (SH-51Cの負荷を軽減)
      const compressed = await compressToBase64(tasks[i].file, 640, 0.3);

      // サーバーへ送信 (server.jsが Accepted 202 を即レスするので速い)
      const response = await fetch("/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          staff, site, reportDate,
          workTypeLabel: workTypeLabels[workType],
          workTime: workTime || "0",
          allImages: [{ // 1枚入りの配列として送る（server.jsの構造を維持）
            id: tasks[i].id,
            label: tasks[i].label,
            data: compressed
          }]
        })
      });

      if (!response.ok) throw new Error("送信中にエラーが発生しました");

      // CPU冷却とメモリ解放のための極小スリープ
      await new Promise(r => setTimeout(r, 50));
    }

    // --- 5. 完了処理 ---
    progText.innerText = "送信完了！";
    progBar.style.background = "#28a745";

    setTimeout(() => {
      resetFormExceptStaff();
      if (document.getElementById("screen-lock")) {
        document.getElementById("screen-lock").remove();
      }
    }, 2000);

  } catch (e) {
    console.error(e);
    alert("エラーが発生しました。電波の良い場所でやり直してください。");
    btn.disabled = false;
    if (document.getElementById("screen-lock")) {
      document.getElementById("screen-lock").remove();
    }
  }
}

/**
 * 送信後に担当者(staff)以外をリセットする
 */
function resetFormExceptStaff() {
  const siteEl = document.getElementById("site");
  if (siteEl) siteEl.value = "";

  const dateInput = document.getElementById("reportDate");
  if (dateInput) {
    dateInput.value = new Date().toISOString().split('T')[0];
  }

  document.querySelectorAll('input[type="file"]').forEach(input => {
    input.value = "";
  });

  const workTimeEl = document.getElementById("workTime");
  if (workTimeEl) workTimeEl.value = "";

  const normalRadio = document.querySelector('input[name="workType"][value="normal"]');
  if (normalRadio) {
    normalRadio.checked = true;
    toggleInputsByWorkType(); 
  }

  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = true;
    btn.innerText = "送信";
    btn.style.background = "";
  }
  updateButtonState();
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
 * 6. バリデーション（ボタンの状態更新）
 */
function updateButtonState() {
  const staff = document.getElementById("staff")?.value.trim();
  const site = document.getElementById("site")?.value.trim();
  const reportDate = document.getElementById("reportDate")?.value;
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  const workTime = document.getElementById("workTime")?.value;

  // --- 必須項目の定義（(任意) 以外のIDをリストアップ） ---
  
  // 通常清掃の必須（othersは除外）
  const requiredNormalIds = [
    'photos_amenity', 'photos_kitchen', 'photos_bath', 'photos_living', 'photos_bedroom', 'photos_equipment'
  ];
  
  // 定期清掃の必須（regular_8は除外）
  const requiredRegularIds = [
    'regular_1', 'regular_2', 'regular_3', 'regular_4', 
    'regular_5', 'regular_6', 'regular_7'
  ];

  // --- 各項目の入力状況チェック ---
  
  // 「すべて(every)」ファイルが1枚以上選択されているか
  const isNormalComplete = requiredNormalIds.every(id => (document.getElementById(id)?.files?.length || 0) > 0);
  const isRegularComplete = requiredRegularIds.every(id => (document.getElementById(id)?.files?.length || 0) > 0);
  const isFilterComplete = (document.getElementById('photos_filter')?.files?.length || 0) > 0;
  
  // 作業時間の選択（空でなく、"0"でもないこと）
  const isTimeSelected = (workTime && workTime !== "" && workTime !== "0");

  let isValid = false;

  // 基本情報（日付・スタッフ・現場）が入力されていることが大前提
  if (staff && site && reportDate) {
    if (workType === 'normal') {
      // 通常清掃のみ：通常写真がすべて揃っていればOK
      isValid = isNormalComplete;
    } else if (workType === 'regular') {
      // 定期清掃のみ：通常写真＋定期写真がすべて揃っていればOK
      isValid = isNormalComplete && isRegularComplete;
    } else if (workType === 'filter') {
      // フィルターのみ：通常写真＋フィルター写真＋時間が揃っていればOK
      isValid = isNormalComplete && isFilterComplete && isTimeSelected;
    } else if (workType === 'full') {
      // 全部盛り：すべて揃っていればOK
      isValid = isNormalComplete && isRegularComplete && isFilterComplete && isTimeSelected;
    }
  }

  // --- ボタンへの反映 ---
  const btn = document.getElementById("submitBtn");
  if (btn) {
    btn.disabled = !isValid;
    btn.style.opacity = isValid ? "1" : "0.5";
    btn.style.cursor = isValid ? "pointer" : "not-allowed";
  }
}
/**
 * 7. イベント登録（一括）
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
  // 何かが変わったらボタン判定
  updateButtonState();
});

// 入力項目へのイベント登録を確実にする
['staff', 'site', 'reportDate', 'workTime'].forEach(id => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener('input', updateButtonState);
    el.addEventListener('change', updateButtonState); // セレクトボックス対策
  }
});
