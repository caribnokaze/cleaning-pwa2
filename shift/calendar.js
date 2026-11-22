const staff = document.getElementById("staff");
const month = document.getElementById("month");
const days = document.getElementById("days");
const detail = document.getElementById("detail");
const status = document.getElementById("status");
const previous = document.getElementById("previous");
const next = document.getElementById("next");
const reload = document.getElementById("reload");
const legacyNotice = document.getElementById("legacy-notice");
const weekday = ["日", "月", "火", "水", "木", "金", "土"];
const reportStaffKey = "selectedStaffForLoginSession";
let calendarRequest;

function restoreStaff() {
  try {
    const remembered = localStorage.getItem(reportStaffKey);
    localStorage.removeItem("selectedShiftStaffForLoginSession");
    staff.value = [...staff.options].some((option) => option.value === remembered) ? remembered : "";
  } catch {
    // ストレージを使えない端末でも担当者を選択できます。
  }
}

function selectStaff() {
  void loadCalendar();
}

function render(daysByDate = new Map()) {
  days.replaceChildren();
  detail.textContent = "";
  if (!month.value) return;
  const [year, number] = month.value.split("-").map(Number);
  const firstWeekday = new Date(year, number - 1, 1).getDay();
  const lastDay = new Date(year, number, 0).getDate();
  for (let offset = 0; offset < firstWeekday; offset += 1) {
    days.append(document.createElement("div"));
  }
  for (let day = 1; day <= lastDay; day += 1) {
    const answer = daysByDate.get(day);
    const dayOfWeek = (firstWeekday + day - 1) % 7;
    const dayNumber = document.createElement("span");
    dayNumber.textContent = day;
    if (dayOfWeek === 0) dayNumber.className = "sunday-date";
    if (dayOfWeek === 6) dayNumber.className = "saturday-date";
    if (answer === undefined) {
      days.append(dayNumber);
      continue;
    }
    const date = `${number}月${day}日（${weekday[dayOfWeek]}）`;
    const cell = document.createElement("button");
    cell.type = "button";
    cell.className = "day";
    if (answer) cell.classList.add(answer === "休" ? "rest" : answer === "未定" ? "pending" : "code");
    cell.setAttribute("aria-pressed", "false");
    cell.setAttribute("aria-label", `${date} ${answer || "未入力"}`);
    const value = document.createElement("span");
    value.className = "answer";
    value.textContent = answer;
    cell.append(dayNumber, value);
    cell.addEventListener("click", () => {
      days.querySelector('[aria-pressed="true"]')?.setAttribute("aria-pressed", "false");
      cell.setAttribute("aria-pressed", "true");
      detail.textContent = `${date} ｜ ${answer || "未入力"}`;
    });
    days.append(cell);
  }
}

async function loadCalendar() {
  calendarRequest?.abort();
  render();
  previous.disabled = !month.value || month.selectedIndex <= 0;
  next.disabled = !month.value || month.selectedIndex >= month.options.length - 1;
  if (!month.value) {
    status.textContent = "表示できる月のシートがありません。";
    return;
  }
  if (!staff.value) {
    status.textContent = "担当者を選択してください。";
    return;
  }
  const controller = new AbortController();
  calendarRequest = controller;
  status.textContent = "読み込み中…";
  try {
    const query = new URLSearchParams({ month: month.value, staff: staff.value });
    const response = await fetch(`/shift-requests/api/calendar?${query}`, {
      cache: "no-store", signal: controller.signal,
    });
    const result = await response.json();
    if (controller.signal.aborted) return;
    if (!response.ok) throw new Error(result.error);
    if (result.status === "no-sheet") {
      status.textContent = "この月のシートはありません。";
    } else if (result.status === "no-response") {
      status.textContent = "この月の提出はありません。";
    } else {
      render(new Map(result.days.map(({ day, answer }) => [day, answer])));
      status.textContent = "";
    }
  } catch (error) {
    if (!controller.signal.aborted) status.textContent = error instanceof SyntaxError
      ? "希望シフトを取得できませんでした。"
      : error.message || "希望シフトを取得できませんでした。";
  }
}

function moveMonth(step) {
  month.selectedIndex += step;
  void loadCalendar();
}

async function initialize() {
  reload.disabled = true;
  render();
  status.textContent = "担当者と年月を読み込み中…";
  try {
    const [staffResponse, monthResponse] = await Promise.all([
      fetch("/shift-requests/api/staff", { cache: "no-store" }),
      fetch("/shift-requests/api/months", { cache: "no-store" }),
    ]);
    if (!staffResponse.ok) throw new Error("担当者一覧を取得できませんでした。");
    if (!monthResponse.ok) throw new Error("希望シフトの年月一覧を取得できませんでした。");
    const [options, months] = await Promise.all([staffResponse.json(), monthResponse.json()]);
    legacyNotice.hidden = monthResponse.headers.get("X-Shift-Month-Source") !== "legacy";
    for (const option of options) staff.add(new Option(option.label, option.value));
    restoreStaff();
    staff.disabled = false;
    if (months.length) {
      month.replaceChildren(...months.map((value) => {
        const [year, number] = value.split("-").map(Number);
        return new Option(`${year}年${number}月`, value);
      }));
      month.selectedIndex = month.options.length - 1;
      month.disabled = false;
    }
    staff.addEventListener("change", selectStaff);
    month.addEventListener("change", loadCalendar);
    previous.addEventListener("click", () => moveMonth(-1));
    next.addEventListener("click", () => moveMonth(1));
    reload.removeEventListener("click", initialize);
    reload.addEventListener("click", loadCalendar);
    await loadCalendar();
  } catch (error) {
    status.textContent = error.message + " 再読み込みしてください。";
  } finally {
    reload.disabled = false;
  }
}

reload.addEventListener("click", initialize);
window.addEventListener("pageshow", (event) => {
  if (!event.persisted || staff.disabled) return;
  const previousStaff = staff.value;
  restoreStaff();
  if (staff.value !== previousStaff) void loadCalendar();
});
void initialize();
