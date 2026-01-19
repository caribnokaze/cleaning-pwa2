/**
 * 1. ページ読み込み時の初期設定
 */
window.addEventListener('DOMContentLoaded', () => {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) dateInput.valueAsDate = new Date();

  const workTimeSelect = document.getElementById('workTime');
  const extraPhotosInput = document.getElementById('extraPhotos');
  const defaultWorkType = document.querySelector('input[name="workType"]:checked');

  if (workTimeSelect && extraPhotosInput && defaultWorkType && defaultWorkType.value === 'normal') {
    workTimeSelect.disabled = true;
    extraPhotosInput.disabled = true;
    workTimeSelect.style.opacity = "0.5";
    extraPhotosInput.style.opacity = "0.5";
  }

  updateButtonState();
});

/**
 * 2. メイン送信関数（UI直送）
 */
async function send() {
  const btn = document.getElementById("submitBtn");
  let isSuccess = false;

  // 画面ロック（送信中に二度押しされないようにする）
  const lockLayer = document.createElement("div");
  lockLayer.id = "screen-lock";
  Object.assign(lockLayer.style, {
    position: "fixed", top: "0", left: "0", width: "100%", height: "100%",
    background: "rgba(0,0,0,0.1)", zIndex: "9999", cursor: "not-allowed"
  });
  document.body.appendChild(lockLayer);

  try {
    // 1. 入力値の取得
    const staff = document.getElementById("staff").value;
    const site = document.getElementById("site").value;
    const reportDate = document.getElementById("reportDate").value;
    const files = document.getElementById("photos").files;
    const workTypeEl = document.querySelector('input[name="workType"]:checked');
    const workType = workTypeEl ? workTypeEl.value : "";
    const workTime = document.getElementById("workTime").value;
    const extraFiles = document.getElementById("extraPhotos").files;

    if (!site || !staff || !reportDate || !workType || !files.length) {
      alert("必須項目をすべて入力してください");
      lockLayer.remove();
      return;
    }

    const workTypeLabels = {
      normal: "通常清掃のみ", full: "定期清掃＋フィルター清掃",
      regular: "定期清掃のみ", filter: "フィルター清掃のみ"
    };
    const workTypeLabel = workTypeLabels[workType] || "その他";

    // 2. 画像圧縮フェーズ
    btn.disabled = true;
    btn.innerText = "画像を圧縮中...";

    const allFiles = [
      ...Array.from(files).map(f => ({ file: f, isExtra: false })),
      ...Array.from(extraFiles).map(f => ({ file: f, isExtra: true }))
    ];

    const allImages = [];
    for (let i = 0; i < allFiles.length; i++) {
      const item = allFiles[i];
      const label = item.isExtra ? `_${workTypeLabel}` : "";
      const compressed = await compressToBase64(item.file, 800, 0.3);

      allImages.push({
        name: `${site}_(${reportDate})_${staff}${label}_${i + 1}`,
        data: compressed,
        isExtra: item.isExtra
      });
      btn.innerText = `圧縮中 (${i + 1}/${allFiles.length})`;
    }

    // 3. Cloud Runへ「一括」送信
    // ここで一気に送ることで、ブラウザ側の待ち時間を最小化します
    btn.innerText = `データを送信中...`;

    const response = await fetch("/upload", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        staff,
        site,
        reportDate,
        workTypeLabel,
        workTime,
        allImages: allImages // 全画像を配列でまとめて送信
      })
    });

    if (!response.ok) throw new Error("サーバーへの送信に失敗しました");

    // 4. 成功表示（ユーザーはここでスマホをしまってもOK）
    isSuccess = true;
    btn.innerText = "送信完了！";
    btn.style.background = "#28a745";
    btn.style.color = "#fff";

    const msg = document.createElement("p");
    msg.innerHTML = "<strong>送信を受け付けました！</strong><br>裏側で処理していますので、画面を閉じても大丈夫です。";
    msg.style.textAlign = "center";
    msg.style.color = "#28a745";
    msg.style.margin = "10px 0";

    btn.parentNode.insertBefore(msg, btn);

    // 3秒後にリロード
    setTimeout(() => location.reload(), 3000);

  } catch (e) {
    console.error(e);
    alert("エラーが発生しました。通信環境を確認してください。");
    btn.disabled = false;
    btn.innerText = "送信";
  } finally {
    if (!isSuccess) lockLayer.remove();
  }
}

/**
 * 3. 画像圧縮
 */
function compressToBase64(file, maxWidth, quality) {
  return new Promise((resolve, reject) => {
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
      img.onerror = () => reject(new Error("画像デコード失敗"));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error("FileReader失敗"));
    reader.readAsDataURL(file);
  });
}

/**
 * 4. 清掃区分切替
 */
document.addEventListener('change', e => {
  if (e.target.name !== 'workType') return;

  const workTime = document.getElementById('workTime');
  const extraPhotos = document.getElementById('extraPhotos');

  if (e.target.value === 'normal') {
    workTime.disabled = true;
    workTime.value = "";
    extraPhotos.disabled = true;
    extraPhotos.value = "";
    workTime.style.opacity = extraPhotos.style.opacity = "0.5";
  } else if (e.target.value === 'regular') {
    workTime.disabled = true;
    workTime.value = "";
    extraPhotos.disabled = false;
    workTime.style.opacity = "0.5";
    extraPhotos.style.opacity = "1";
  } else {
    workTime.disabled = false;
    extraPhotos.disabled = false;
    workTime.style.opacity = extraPhotos.style.opacity = "1";
  }

  updateButtonState();
});

/**
 * 5. 枚数制限
 */
const checkFileCount = e => {
  if (e.target.files.length > 100) {
    alert("一度に選択できるのは100枚までです");
    e.target.value = "";
  }
};

document.getElementById('photos').addEventListener('change', checkFileCount);
document.getElementById('extraPhotos').addEventListener('change', checkFileCount);

/**
 * 6. 送信ボタン制御
 */
function updateButtonState() {
  const staff = document.getElementById("staff").value;
  const site = document.getElementById("site").value;
  const reportDate = document.getElementById("reportDate").value;
  const files = document.getElementById("photos").files;
  const workType = document.querySelector('input[name="workType"]:checked')?.value;
  const workTime = document.getElementById("workTime").value;
  const extraFiles = document.getElementById("extraPhotos").files;
  const btn = document.getElementById("submitBtn");

  let valid = staff && site && reportDate && workType && files.length;

  if (workType === 'full' || workType === 'filter') {
    valid = valid && workTime && extraFiles.length;
  } else if (workType === 'regular') {
    valid = valid && extraFiles.length;
  }

  btn.disabled = !valid;
  btn.style.opacity = valid ? "1" : "0.5";
}

['staff', 'site', 'reportDate', 'workTime']
  .forEach(id => document.getElementById(id).addEventListener('input', updateButtonState));

document.getElementsByName('workType')
  .forEach(el => el.addEventListener('change', updateButtonState));

document.getElementById('photos').addEventListener('change', updateButtonState);
document.getElementById('extraPhotos').addEventListener('change', updateButtonState);
