function isHeicFile(file) {
  return (
    file.type === "image/heic" ||
    file.type === "image/heif" ||
    /\.heic$/i.test(file.name) ||
    /\.heif$/i.test(file.name)
  );
}

const HEIC_GUIDANCE =
  "HEIC形式の写真はアップロードできません。\n\n" +
  "iPhoneの「設定」→「カメラ」→「フォーマット」で、" +
  "「互換性優先」を選んでから撮影し直してください。";

// Prepare selected photos in the background so Send feels immediate.
const compressedPhotoCache = new WeakMap();
const compressionQueue = [];
let activeCompressions = 0;
const PRECOMPRESSION_CONCURRENCY = 2;

function runNextCompression() {
  while (
    activeCompressions < PRECOMPRESSION_CONCURRENCY &&
    compressionQueue.length
  ) {
    const job = compressionQueue.shift();
    activeCompressions++;
    Promise.race([
      compressImageToJpegBlob(job.file, 720, 0.45),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error("画像変換・圧縮がタイムアウトしました")),
          10000,
        ),
      ),
    ])
      .then(job.resolve, job.reject)
      .finally(() => {
        activeCompressions--;
        runNextCompression();
      });
  }
}

function getCompressedPhoto(file) {
  if (!compressedPhotoCache.has(file)) {
    const promise = new Promise((resolve, reject) => {
      compressionQueue.push({ file, resolve, reject });
      runNextCompression();
    });
    compressedPhotoCache.set(file, promise);
  }
  return compressedPhotoCache.get(file);
}

function showPhotoPreviews(input) {
  const files = Array.from(input.files);
  const visibleFiles = files.slice(0, 5);
  let preview = input.nextElementSibling;
  if (!preview?.classList.contains("photo-preview-list")) {
    preview = document.createElement("div");
    preview.className = "photo-preview-list";
    input.insertAdjacentElement("afterend", preview);
  }

  preview.querySelectorAll("img").forEach((img) => {
    if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
  });
  preview.replaceChildren();

  // Queue every selected photo immediately, but render only the first five.
  const compressionPromises = files.map((file) => getCompressedPhoto(file));

  visibleFiles.forEach((file, index) => {
    const item = document.createElement("div");
    item.className = "photo-preview-item";
    const img = document.createElement("img");
    const objectUrl = URL.createObjectURL(file);
    img.src = objectUrl;
    img.alt = file.name;
    img.dataset.objectUrl = objectUrl;
    const status = document.createElement("span");
    status.textContent = "準備中";
    item.append(img, status);
    preview.append(item);

    compressionPromises[index].then(
      () => {
        status.textContent = "送信準備OK";
        item.classList.add("is-ready");
      },
      () => {
        status.textContent = "送信時に再処理";
        item.classList.add("has-error");
        compressedPhotoCache.delete(file);
      },
    );
  });

  if (files.length > 5) {
    const backgroundFiles = files.slice(5);
    let backgroundCompleted = 0;
    let backgroundFailed = 0;
    const remaining = document.createElement("p");
    remaining.className = "photo-preview-remaining";
    remaining.textContent = `ほか${backgroundFiles.length}枚も裏側で送信準備中です`;
    preview.append(remaining);

    backgroundFiles.forEach((file, index) => {
      compressionPromises[index + 5]
        .catch(() => {
          backgroundFailed++;
          compressedPhotoCache.delete(file);
        })
        .finally(() => {
          backgroundCompleted++;
          remaining.textContent =
            backgroundCompleted === backgroundFiles.length
              ? backgroundFailed
                ? `ほか${backgroundFiles.length}枚の準備完了（${backgroundFailed}枚は送信時に再処理）`
                : `ほか${backgroundFiles.length}枚も送信準備が完了しました`
              : `ほか${backgroundFiles.length}枚を裏側で送信準備中です（${backgroundCompleted}/${backgroundFiles.length}）`;
        });
    });
  }
}

function formatLocalDate(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function updateGalleryLink() {
  const link = document.getElementById("galleryLink");
  const reportDate = document.getElementById("reportDate")?.value || "";
  if (!link) return;
  link.href = /^\d{4}-\d{2}-\d{2}$/.test(reportDate)
    ? `gallery.html?date=${encodeURIComponent(reportDate)}`
    : "gallery.html";
}

function setReportDateToToday() {
  const dateInput = document.getElementById("reportDate");
  if (dateInput) dateInput.value = formatLocalDate();
  updateGalleryLink();
}

/**
 * 1. ページ読み込み時の初期設定
 */
const SELECTED_STAFF_STORAGE_KEY = "selectedStaffForLoginSession";

function setupStaffInput() {
  const staffDisplay = document.getElementById("staffDisplay");
  const staffInput = document.getElementById("staff");
  const suggestions = document.getElementById("staffSuggestions");
  const options = [...document.querySelectorAll("#staffOptions option")];
  if (!staffDisplay || !staffInput || !suggestions) return;

  options.forEach((option) => {
    option.dataset.staff = option.value;
    option.value = option.label;
    option.removeAttribute("label");
  });

  let activeIndex = -1;

  const closeSuggestions = () => {
    suggestions.hidden = true;
    staffDisplay.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  };

  const selectStaff = (option) => {
    staffDisplay.value = option.value;
    staffInput.value = option.dataset.staff;
    closeSuggestions();
    updateButtonState();
    rememberSelectedStaff();
  };

  const renderSuggestions = () => {
    const query = normalizeSiteSearch(staffDisplay.value);
    const matches = rankSearchMatches(
      options,
      query,
      (option) => [option.value, option.dataset.staff],
    );
    suggestions.replaceChildren();
    matches.forEach((staffOption) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "searchable-select-option";
      button.role = "option";
      button.textContent = staffOption.value;
      button.addEventListener("mousedown", (event) => event.preventDefault());
      button.addEventListener("click", () => selectStaff(staffOption));
      suggestions.appendChild(button);
    });
    suggestions.hidden = matches.length === 0;
    staffDisplay.setAttribute("aria-expanded", String(matches.length > 0));
    activeIndex = -1;
  };

  const commitStaffSelection = () => {
    const enteredValue = normalizeSiteSearch(staffDisplay.value);
    const selectedOption = options.find(
      (option) =>
        normalizeSiteSearch(option.value) === enteredValue ||
        normalizeSiteSearch(option.dataset.staff) === enteredValue,
    );
    if (selectedOption) {
      selectStaff(selectedOption);
      return;
    }
    staffDisplay.value = "";
    staffInput.value = "";
    closeSuggestions();
    updateButtonState();
    rememberSelectedStaff();
  };

  staffDisplay.addEventListener("focus", renderSuggestions);
  staffDisplay.addEventListener("input", () => {
    staffInput.value = "";
    renderSuggestions();
    updateButtonState();
  });
  staffDisplay.addEventListener("blur", commitStaffSelection);
  staffDisplay.addEventListener("keydown", (event) => {
    const buttons = [...suggestions.querySelectorAll("button")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!buttons.length) return;
      event.preventDefault();
      activeIndex =
        event.key === "ArrowDown"
          ? (activeIndex + 1) % buttons.length
          : (activeIndex - 1 + buttons.length) % buttons.length;
      buttons.forEach((button, index) =>
        button.classList.toggle("is-active", index === activeIndex),
      );
      buttons[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectStaff(options.find((option) => option.value === buttons[activeIndex].textContent));
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });
}

function normalizeSiteSearch(value) {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").trim();
}

function romanizeKana(value) {
  const kana = normalizeSiteSearch(value).replace(/[ァ-ヶ]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) - 0x60),
  );
  const kanaMap = {
    きゃ: "kya", きゅ: "kyu", きょ: "kyo", しゃ: "sha", しゅ: "shu", しょ: "sho",
    ちゃ: "cha", ちゅ: "chu", ちょ: "cho", にゃ: "nya", にゅ: "nyu", にょ: "nyo",
    ひゃ: "hya", ひゅ: "hyu", ひょ: "hyo", みゃ: "mya", みゅ: "myu", みょ: "myo",
    りゃ: "rya", りゅ: "ryu", りょ: "ryo", ぎゃ: "gya", ぎゅ: "gyu", ぎょ: "gyo",
    じゃ: "ja", じゅ: "ju", じょ: "jo", びゃ: "bya", びゅ: "byu", びょ: "byo",
    ぴゃ: "pya", ぴゅ: "pyu", ぴょ: "pyo", ふぁ: "fa", ふぃ: "fi", ふぇ: "fe", ふぉ: "fo",
    てぃ: "ti", でぃ: "di", うぃ: "wi", うぇ: "we", うぉ: "wo", しぇ: "she", ちぇ: "che",
    あ: "a", い: "i", う: "u", え: "e", お: "o", か: "ka", き: "ki", く: "ku", け: "ke", こ: "ko",
    さ: "sa", し: "shi", す: "su", せ: "se", そ: "so", た: "ta", ち: "chi", つ: "tsu", て: "te", と: "to",
    な: "na", に: "ni", ぬ: "nu", ね: "ne", の: "no", は: "ha", ひ: "hi", ふ: "fu", へ: "he", ほ: "ho",
    ま: "ma", み: "mi", む: "mu", め: "me", も: "mo", や: "ya", ゆ: "yu", よ: "yo",
    ら: "ra", り: "ri", る: "ru", れ: "re", ろ: "ro", わ: "wa", を: "o", ん: "n",
    が: "ga", ぎ: "gi", ぐ: "gu", げ: "ge", ご: "go", ざ: "za", じ: "ji", ず: "zu", ぜ: "ze", ぞ: "zo",
    だ: "da", ぢ: "ji", づ: "zu", で: "de", ど: "do", ば: "ba", び: "bi", ぶ: "bu", べ: "be", ぼ: "bo",
    ぱ: "pa", ぴ: "pi", ぷ: "pu", ぺ: "pe", ぽ: "po", ぁ: "a", ぃ: "i", ぅ: "u", ぇ: "e", ぉ: "o",
  };
  let result = "";
  let doubleNext = false;
  for (let index = 0; index < kana.length; index += 1) {
    const character = kana[index];
    if (character === "っ") {
      doubleNext = true;
      continue;
    }
    if (character === "ー") {
      const vowel = result.match(/[aeiou]$/)?.[0];
      if (vowel) result += vowel;
      continue;
    }
    const pair = kana.slice(index, index + 2);
    let converted = kanaMap[pair];
    if (converted) index += 1;
    else converted = kanaMap[character] || character;
    if (doubleNext && /^[a-z]/.test(converted)) converted = converted[0] + converted;
    doubleNext = false;
    result += converted;
  }
  return result;
}

function siteSearchQueries(value) {
  const normalized = normalizeSiteSearch(value);
  const romanized = romanizeKana(value);
  return [...new Set([normalized, romanized])];
}

function rankSearchMatches(items, query, getSearchValues) {
  const queries = Array.isArray(query) ? query : [query];
  return items
    .map((item, originalIndex) => {
      const positions = getSearchValues(item)
        .flatMap((value) =>
          queries.map((searchQuery) =>
            normalizeSiteSearch(value).indexOf(searchQuery),
          ),
        )
        .filter((position) => position >= 0);
      return {
        item,
        originalIndex,
        matchPosition: positions.length ? Math.min(...positions) : -1,
      };
    })
    .filter((match) => match.matchPosition >= 0)
    .sort(
      (left, right) =>
        left.matchPosition - right.matchPosition ||
        left.originalIndex - right.originalIndex,
    )
    .map((match) => match.item);
}

function setupSiteInput() {
  const siteDisplay = document.getElementById("siteDisplay");
  const siteInput = document.getElementById("site");
  const suggestions = document.getElementById("siteSuggestions");
  const sites = [...document.querySelectorAll("#siteOptions option")]
    .map((option) => option.value)
    .filter(Boolean);
  if (!siteDisplay || !siteInput || !suggestions) return;

  let activeIndex = -1;

  const closeSuggestions = () => {
    suggestions.hidden = true;
    siteDisplay.setAttribute("aria-expanded", "false");
    activeIndex = -1;
  };

  const selectSite = (site) => {
    siteDisplay.value = site;
    siteInput.value = site;
    closeSuggestions();
    updateButtonState();
  };

  const renderSuggestions = () => {
    const query = siteSearchQueries(siteDisplay.value);
    const matches = rankSearchMatches(
      sites,
      query,
      (site) => [site],
    );
    suggestions.replaceChildren();
    matches.forEach((site) => {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "searchable-select-option";
      option.role = "option";
      option.textContent = site;
      option.addEventListener("mousedown", (event) => event.preventDefault());
      option.addEventListener("click", () => selectSite(site));
      suggestions.appendChild(option);
    });
    suggestions.hidden = matches.length === 0;
    siteDisplay.setAttribute("aria-expanded", String(matches.length > 0));
    activeIndex = -1;
  };

  const commitSite = () => {
    const query = normalizeSiteSearch(siteDisplay.value);
    const exactSite = sites.find((site) => normalizeSiteSearch(site) === query);
    if (exactSite) {
      selectSite(exactSite);
    } else {
      siteDisplay.value = "";
      siteInput.value = "";
      closeSuggestions();
      updateButtonState();
    }
  };

  siteDisplay.addEventListener("focus", renderSuggestions);
  siteDisplay.addEventListener("input", () => {
    siteInput.value = "";
    renderSuggestions();
    updateButtonState();
  });
  siteDisplay.addEventListener("blur", commitSite);
  siteDisplay.addEventListener("keydown", (event) => {
    const options = [...suggestions.querySelectorAll("button")];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!options.length) return;
      event.preventDefault();
      activeIndex =
        event.key === "ArrowDown"
          ? (activeIndex + 1) % options.length
          : (activeIndex - 1 + options.length) % options.length;
      options.forEach((option, index) =>
        option.classList.toggle("is-active", index === activeIndex),
      );
      options[activeIndex].scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && activeIndex >= 0) {
      event.preventDefault();
      selectSite(options[activeIndex].textContent);
    } else if (event.key === "Escape") {
      closeSuggestions();
    }
  });
}

function restoreSelectedStaff() {
  const staffInput = document.getElementById("staff");
  const staffDisplay = document.getElementById("staffDisplay");
  if (!staffInput || !staffDisplay) return;

  try {
    const rememberedStaff = localStorage.getItem(SELECTED_STAFF_STORAGE_KEY);
    const rememberedOption = [...document.querySelectorAll("#staffOptions option")].find(
      (option) => option.dataset.staff === rememberedStaff,
    );
    if (rememberedStaff && rememberedOption) {
      staffInput.value = rememberedStaff;
      staffDisplay.value = rememberedOption.value;
    }
  } catch (error) {
    console.warn("担当者名を復元できませんでした。", error);
  }
}

function rememberSelectedStaff() {
  const selectedStaff = document.getElementById("staff")?.value || "";

  try {
    if (selectedStaff) {
      localStorage.setItem(SELECTED_STAFF_STORAGE_KEY, selectedStaff);
    } else {
      localStorage.removeItem(SELECTED_STAFF_STORAGE_KEY);
    }
  } catch (error) {
    console.warn("担当者名を保存できませんでした。", error);
  }
}

window.addEventListener("DOMContentLoaded", () => {
  setReportDateToToday();
  setupStaffInput();
  setupSiteInput();
  restoreSelectedStaff();

  toggleInputsByWorkType();
  updateButtonState();

  // ラジオボタンの監視
  document.querySelectorAll('input[name="workType"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      toggleInputsByWorkType();
      updateButtonState();
    });
  });
});

window.addEventListener("pageshow", (event) => {
  if (!event.persisted) return;
  setReportDateToToday();
  updateButtonState();
});

/**
 * 2. 枚数制限設定
 */
const FILE_LIMITS = {
  photos_amenity: 10,
  photos_general: 100,
  photos_kitchen: 15,
  photos_bath: 15,
  photos_living: 15,
  photos_bedroom: 15,
  photos_hallway: 10,
  photos_equipment: 20,
  photos_others: 10,
  regular_1: 10,
  regular_2: 10,
  regular_3: 10,
  regular_4: 10,
  regular_5: 10,
  regular_6: 10,
  regular_7: 10,
  regular_8: 10,
  photos_filter: 10,
};

/**
 * 3. 入力項目の有効・無効切り替え
 */
function toggleInputsByWorkType() {
  const workType = document.querySelector(
    'input[name="workType"]:checked',
  )?.value;
  if (!workType) return;

  const regularAreas = ["area_regular"];
  const filterAreas = ["area_filter_photo", "area_workTime"];
  const regularInputs = [
    "regular_1",
    "regular_2",
    "regular_3",
    "regular_4",
    "regular_5",
    "regular_6",
    "regular_7",
    "regular_8",
  ];
  const filterInputs = ["photos_filter", "workTime"];

  const updateUI = (areaIds, inputIds, enabled) => {
    areaIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.opacity = enabled ? "1" : "0.5";
    });
    inputIds.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        el.disabled = !enabled;
        if (!enabled) el.value = "";
      }
    });
  };

  const areaNormal = document.getElementById("area_normal");
  if (areaNormal) areaNormal.style.opacity = "1";

  const isRegularActive = workType === "regular" || workType === "full";
  const isFilterActive = workType === "filter" || workType === "full";

  updateUI(regularAreas, regularInputs, isRegularActive);
  updateUI(filterAreas, filterInputs, isFilterActive);
}

/**
 * 4. メイン送信関数 (Android SH-51C 救済・S3フリーズガードモデル)
 */
async function send() {
  const btn = document.getElementById("submitBtn");
  if (btn.disabled) return;

  // --- 1. 入力値の取得 ---
  const staff = document.getElementById("staff").value;
  const site = document.getElementById("site").value;
  const reportDate = document.getElementById("reportDate").value;
  const workType =
    document.querySelector('input[name="workType"]:checked')?.value || "";
  const workTime = document.getElementById("workTime").value;

  const workTypeLabels = {
    normal: "通常清掃のみ",
    full: "定期清掃＋フィルター清掃",
    regular: "定期清掃のみ",
    filter: "フィルター清掃のみ",
  };

  // --- 2. 確認ダイアログの表示 ---
  const confirmMsg =
    `以下の内容で送信します。よろしいですか？\n\n` +
    `📅 清掃日：${reportDate}\n` +
    `👤 担当者：${staff}\n` +
    `🏠 現場名：${site}\n` +
    `📋 区分：${workTypeLabels[workType]}` +
    (workType === "filter" || workType === "full"
      ? `\n⏱️ フィルター清掃時間：${workTime}分`
      : "");

  if (!confirm(confirmMsg)) {
    return;
  }

  // --- 3. 進捗表示レイヤーの作成 ---
  const lockLayer = document.createElement("div");
  lockLayer.id = "screen-lock";
  Object.assign(lockLayer.style, {
    position: "fixed",
    top: "0",
    left: "0",
    width: "100%",
    height: "100%",
    background: "rgba(0,0,0,0.7)",
    zIndex: "9999",
    color: "white",
    display: "flex",
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    textAlign: "center",
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
      { id: "photos_amenity", label: "タオル・歯ブラシ・Wi-Fi・NetFlix" },
      { id: "photos_general", label: "その他全般" },
      { id: "photos_kitchen", label: "キッチン" },
      { id: "photos_bath", label: "お風呂/洗面/トイレ" },
      { id: "photos_living", label: "リビング" },
      { id: "photos_bedroom", label: "寝室" },
      { id: "photos_hallway", label: "廊下" },
      { id: "photos_equipment", label: "エアコン本体/照明/WiFi/鍵" },
      { id: "photos_others", label: "物件指定の清掃" },
      { id: "regular_1", label: "定期_リビング" },
      { id: "regular_2", label: "定期_寝室" },
      { id: "regular_3", label: "定期_キッチン" },
      { id: "regular_4", label: "定期_水回り" },
      { id: "regular_5", label: "定期_窓建具" },
      { id: "regular_6", label: "定期_屋外" },
      { id: "regular_7", label: "定期_場所横断" },
      { id: "regular_8", label: "定期_その他" },
      { id: "photos_filter", label: "フィルター" },
    ];

    // 全ファイルリストの作成
    let tasks = [];
    fileInputs.forEach((input) => {
      const el = document.getElementById(input.id);
      if (el && !el.disabled && el.files.length) {
        Array.from(el.files).forEach((f) =>
          tasks.push({ file: f, label: input.label, id: input.id }),
        );
      }
    });

    const total = tasks.length;
    btn.disabled = true;

    // --- 4. 署名URLを一括取得し、4枚ずつ連続でS3へ直接送信 ---
    let uploadedFileUrls = [];

    const CONCURRENT_UPLOADS = 4;
    let completedCount = 0;

    const categoryCounts = new Map();
    tasks.forEach((task) => {
      const categoryIndex = (categoryCounts.get(task.id) || 0) + 1;
      categoryCounts.set(task.id, categoryIndex);
      const fileNumber = categoryIndex.toString().padStart(3, "0");
      task.filename =
        task.id === "photos_filter" && workTime
          ? `${fileNumber}_${workTime}min.jpg`
          : `${fileNumber}.jpg`;
    });

    async function prepareUploadTargets(targetTasks) {
      const tokenRes = await fetch("/get-presigned-urls", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date: reportDate,
          site,
          staff,
          files: targetTasks.map((task) => ({
            filename: task.filename,
            contentType: "image/jpeg",
            photoId: task.id,
          })),
        }),
      });

      if (!tokenRes.ok) throw new Error("アップロード準備に失敗しました");
      const uploadTargets = await tokenRes.json();
      if (uploadTargets.length !== targetTasks.length) {
        throw new Error("アップロード準備件数が一致しません");
      }
      targetTasks.forEach((task, index) =>
        Object.assign(task, uploadTargets[index]),
      );
    }

    async function uploadOne(task, index) {
      console.log(task.file.name, task.file.type);
      const blob = await getCompressedPhoto(task.file);

      console.log(`圧縮後サイズ: ${(blob.size / 1024).toFixed(1)} KB`);

      const s3Res = await fetch(task.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "image/jpeg",
        },
        body: blob,
      });

      if (!s3Res.ok) throw new Error("S3へのアップロードに失敗");

      uploadedFileUrls.push({
        id: task.id,
        label: task.label,
        s3Url: task.fileUrl,
      });

      completedCount++;
      progText.innerText = `送信中: ${completedCount} / ${total} 枚完了`;
      progBar.style.width = `${(completedCount / total) * 100}%`;

      console.log(`[デバッグ] ${index + 1}枚目 送信成功！`);
    }

    async function uploadTaskGroup(targetTasks) {
      const failedTasks = [];
      let nextTaskIndex = 0;

      try {
        progText.innerText = "送信準備中...";
        await prepareUploadTargets(targetTasks);
      } catch (error) {
        console.error("アップロード準備に失敗:", error);
        return [...targetTasks];
      }

      async function uploadWorker() {
        while (nextTaskIndex < targetTasks.length) {
          const task = targetTasks[nextTaskIndex++];
          try {
            await uploadOne(task, tasks.indexOf(task));
          } catch (error) {
            console.error(`${task.file.name} の送信に失敗:`, error);
            compressedPhotoCache.delete(task.file);
            failedTasks.push(task);
          }
        }
      }

      await Promise.all(
        Array.from(
          { length: Math.min(CONCURRENT_UPLOADS, targetTasks.length) },
          () => uploadWorker(),
        ),
      );
      return failedTasks;
    }

    async function uploadRound(targetTasks) {
      const failedTasks = [];
      const UPLOAD_URL_BATCH_SIZE = 30;
      for (let start = 0; start < targetTasks.length; start += UPLOAD_URL_BATCH_SIZE) {
        const batch = targetTasks.slice(start, start + UPLOAD_URL_BATCH_SIZE);
        const batchFailures = await uploadTaskGroup(batch);
        failedTasks.push(...batchFailures);
      }
      return failedTasks;
    }

    let pendingTasks = tasks;
    while (pendingTasks.length) {
      pendingTasks = await uploadRound(pendingTasks);
      if (!pendingTasks.length) break;

      progText.innerText = `${pendingTasks.length}枚の送信に失敗しました`;
      const shouldRetry = confirm(
        `${pendingTasks.length}枚の写真を送信できませんでした。\n\n` +
          "［OK］再送する（失敗した写真のみ追加）\n" +
          "［キャンセル］中止して写真をリセットする",
      );

      if (!shouldRetry) {
        resetSelectedPhotos();
        updateButtonState();
        document.getElementById("screen-lock")?.remove();
        return;
      }
    }
    // --- 5. すべての画像がS3に上がったら、GASへ最終報告 ---
    progText.innerText = "サーバーへ転送中...";

    /* GASへの報告は現在停止中
    console.log("S3アップロード完了。GASへの記録リクエストを開始します...");

    const GAS_URL = "https://script.google.com/macros/s/AKfycbzTG0Q3jpzGSwj4uM4110oCUOSf4yQt5eKoEBc1vdwxZmP5QKfuvs_ly7mGs2_nTZr-aQ/exec";

    await fetch(GAS_URL, {
      method: "POST",
      mode: "no-cors",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        staff, site, reportDate,
        workTypeLabel: workTypeLabels[workType],
        workTime: workTime || "0",
        uploadedFiles: uploadedFileUrls
      })
    });
    */

    // --- 6. 完了処理 ---
    progText.innerText = "送信完了！";
    progBar.style.background = "#28a745";
    localStorage.setItem("lastUploadedReportDate", reportDate);
    updateGalleryLink();

    setTimeout(() => {
      resetFormExceptStaff();
      if (document.getElementById("screen-lock")) {
        document.getElementById("screen-lock").remove();
      }
    }, 2000);
  } catch (e) {
    console.error("アップロード全体の失敗:", e);
    alert(
      "エラーが発生しました。電波の良い場所でやり直してください。\nエラー詳細: " +
        e.message,
    );
    btn.disabled = false;
    resetSelectedPhotos();
    updateButtonState();
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
  const siteDisplay = document.getElementById("siteDisplay");
  if (siteDisplay) siteDisplay.value = "";

  const dateInput = document.getElementById("reportDate");
  if (dateInput) {
    dateInput.value = formatLocalDate();
    updateGalleryLink();
  }

  resetSelectedPhotos();

  const workTimeEl = document.getElementById("workTime");
  if (workTimeEl) workTimeEl.value = "";

  const normalRadio = document.querySelector(
    'input[name="workType"][value="normal"]',
  );
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

function resetSelectedPhotos() {
  document.querySelectorAll('input[type="file"]').forEach((input) => {
    input.value = "";
    const preview = input.nextElementSibling;
    if (preview?.classList.contains("photo-preview-list")) {
      preview.querySelectorAll("img").forEach((img) => {
        if (img.dataset.objectUrl) URL.revokeObjectURL(img.dataset.objectUrl);
      });
      preview.remove();
    }
  });
}

/**
 * 5. 画像圧縮
 */
async function compressImageToJpegBlob(file, maxWidth = 720, quality = 0.45) {
  if (isHeicFile(file)) {
    throw new Error(HEIC_GUIDANCE);
  }

  return new Promise((resolve, reject) => {
    const imageUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onerror = () => {
      URL.revokeObjectURL(imageUrl);
      reject(new Error("画像のデコードに失敗しました"));
    };

    img.onload = () => {
      URL.revokeObjectURL(imageUrl);
      try {
        const canvas = document.createElement("canvas");
        let { width, height } = img;

        if (width > maxWidth) {
          height = Math.round((height * maxWidth) / width);
          width = maxWidth;
        }

        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, width, height);

        canvas.toBlob(
          (blob) => {
            if (!blob) {
              reject(new Error("JPEG変換に失敗しました"));
              return;
            }
            resolve(blob);
          },
          "image/jpeg",
          quality,
        );
      } catch (err) {
        reject(err);
      }
    };

    img.src = imageUrl;
  });
}

/**
 * 6. バリデーション（ボタンの状態更新）
 */
function updateButtonState() {
  const staff = document.getElementById("staff")?.value.trim();
  const site = document.getElementById("site")?.value.trim();
  const reportDate = document.getElementById("reportDate")?.value;
  const workType = document.querySelector(
    'input[name="workType"]:checked',
  )?.value;
  const workTime = document.getElementById("workTime")?.value;

  const requiredNormalIds = ["photos_amenity"];
  const requiredRegularIds = [
    "regular_1",
    "regular_2",
    "regular_3",
    "regular_4",
    "regular_5",
    "regular_6",
    "regular_7",
  ];

  const generalCount =
    document.getElementById("photos_general")?.files?.length || 0;
  const isGeneralValid = generalCount >= 30;
  const isNormalComplete =
    requiredNormalIds.every(
      (id) => (document.getElementById(id)?.files?.length || 0) > 0,
    ) && isGeneralValid;
  const isRegularComplete = requiredRegularIds.every(
    (id) => (document.getElementById(id)?.files?.length || 0) > 0,
  );
  const isFilterComplete =
    (document.getElementById("photos_filter")?.files?.length || 0) > 0;

  const isTimeSelected = workTime && workTime !== "" && workTime !== "0";

  let isValid = false;

  if (staff && site && reportDate) {
    if (workType === "normal") {
      isValid = isNormalComplete;
    } else if (workType === "regular") {
      isValid = isNormalComplete && isRegularComplete;
    } else if (workType === "filter") {
      isValid = isNormalComplete && isFilterComplete && isTimeSelected;
    } else if (workType === "full") {
      isValid =
        isNormalComplete &&
        isRegularComplete &&
        isFilterComplete &&
        isTimeSelected;
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
 * 7. イベント登録（一括）
 */
document.addEventListener("change", (e) => {
  if (e.target.type === "file") {
    if (Array.from(e.target.files).some(isHeicFile)) {
      e.target.value = "";
      alert(HEIC_GUIDANCE);
      updateButtonState();
      return;
    }

    const limit = FILE_LIMITS[e.target.id];
    if (limit && e.target.files.length > limit) {
      alert(`最大${limit}枚までです。`);
      e.target.value = "";
    }
    if (e.target.id === "photos_general") {
      const count = e.target.files.length;
      if (count > 0 && count < 30) {
        alert(
          `【その他全般】は30枚以上選択してください。\n現在${count}枚が選択されています。\n選択をやり直してください。`,
        );
        e.target.value = "";
      }
    }
    showPhotoPreviews(e.target);
  }
  updateButtonState();
});

["staff", "site", "reportDate", "workTime"].forEach((id) => {
  const el = document.getElementById(id);
  if (el) {
    el.addEventListener("input", updateButtonState);
    el.addEventListener("change", updateButtonState);
    if (id === "staff") {
      el.addEventListener("change", rememberSelectedStaff);
    }
    if (id === "reportDate") {
      el.addEventListener("input", updateGalleryLink);
      el.addEventListener("change", updateGalleryLink);
    }
  }
});

/**
 * DataURL (Base64) を Blob (バイナリ型) に変換するヘルパー関数
 */
function dataURLtoBlob(dataurl) {
  if (!dataurl || !dataurl.includes(",")) return null;
  const arr = dataurl.split(","),
    mime = arr[0].match(/:(.*?);/)[1];
  const bstr = atob(arr[1]),
    n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}
