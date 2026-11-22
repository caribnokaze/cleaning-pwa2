function doPost(event) {
  try {
    const properties = PropertiesService.getScriptProperties();
    const secret = properties.getProperty("SHIFT_GAS_SECRET") || "";
    const envelope = JSON.parse(event.postData.contents);
    if (secret.length < 32 || !isSignedRequest(envelope, secret)) {
      return shiftJson({ status: "denied" });
    }
    const query = JSON.parse(envelope.payload);
    if (!Number.isSafeInteger(query.timestamp) || Math.abs(Date.now() - query.timestamp) > 60000 ||
        typeof query.nonce !== "string" || !/^[a-f0-9-]{36}$/.test(query.nonce) ||
        !consumeShiftNonce(query.nonce)) {
      return shiftJson({ status: "denied" });
    }

    const spreadsheet = SpreadsheetApp.openById(properties.getProperty("SHIFT_SPREADSHEET_ID"));
    const aliases = JSON.parse(properties.getProperty("SHIFT_MONTH_TABS") || "{}");
    const tabs = recentShiftTabs(spreadsheet.getSheets().map((sheet) => sheet.getName()), aliases);
    if (query.action === "months") return shiftJson({ status: "ok", months: [...tabs.keys()] });
    if (!tabs.has(query.month)) return shiftJson({ status: "month-out-of-range" });
    if (typeof query.number !== "string" || !/^\d+$/.test(query.number)) return shiftJson({ status: "denied" });
    const [year, month] = query.month.split("-").map(Number);
    const sheet = spreadsheet.getSheetByName(tabs.get(query.month));
    const rowCount = sheet.getLastRow() - 1;
    if (rowCount < 1) return shiftJson({ status: "no-response" });
    const columnCount = sheet.getLastColumn();
    const headers = sheet.getRange(1, 1, 1, columnCount).getDisplayValues()[0];
    const dateColumns = shiftDateColumns(headers, year, month);
    const staffCells = sheet.getRange(2, 4, rowCount, 1).getDisplayValues();
    const rowNumber = lastShiftRow(staffCells, query.number);
    if (!rowNumber) return shiftJson({ status: "no-response" });
    const answers = sheet.getRange(rowNumber, 5, 1, columnCount - 4).getDisplayValues()[0];
    const days = dateColumns.map(({ day, column }) => ({
      day,
      answer: answers[column - 4].normalize("NFKC").trim(),
    }));
    if (days.some(({ answer }) => !/^(?:\d{1,3}|休|未定)?$/.test(answer))) {
      return shiftJson({ status: "invalid-data" });
    }
    return shiftJson({ status: "ok", days });
  } catch {
    return shiftJson({ status: "unavailable" });
  }
}

function recentShiftTabs(names, aliases) {
  const tabs = new Map();
  for (const name of names) {
    const match = name.match(/^(20\d{2})\.(0?[1-9]|1[0-2])$/);
    if (match) {
      const month = match[1] + "-" + match[2].padStart(2, "0");
      if (!tabs.has(month) || match[2] === String(Number(match[2]))) tabs.set(month, name);
    }
  }
  for (const [month, name] of Object.entries(aliases)) {
    if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(month) && names.includes(name)) tabs.set(month, name);
  }
  return new Map([...tabs].sort(([left], [right]) => left.localeCompare(right)).slice(-3));
}

function isSignedRequest({ payload, signature }, secret) {
  if (typeof payload !== "string" || payload.length > 1024 ||
      typeof signature !== "string" || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expected = Utilities.computeHmacSha256Signature(payload, secret, Utilities.Charset.UTF_8)
    .map((byte) => (byte & 255).toString(16).padStart(2, "0")).join("");
  let difference = 0;
  for (let i = 0; i < expected.length; i += 1) {
    difference |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return difference === 0;
}

function consumeShiftNonce(nonce) {
  const lock = LockService.getScriptLock();
  lock.waitLock(3000);
  try {
    const cache = CacheService.getScriptCache();
    const key = "shift:" + nonce;
    if (cache.get(key)) return false;
    cache.put(key, "1", 125);
    return true;
  } finally {
    lock.releaseLock();
  }
}

function shiftDateColumns(headers, year, month) {
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const seen = new Set();
  const columns = [];
  headers.slice(4).forEach((header, index) => {
    const match = header.normalize("NFKC").trim().match(/^\[?\s*(\d{1,2})\s*\/\s*(\d{1,2})(?=\s|\(|\]|$)/);
    if (!match || Number(match[1]) !== month) return;
    const day = Number(match[2]);
    if (day < 1 || day > daysInMonth || seen.has(day)) throw new Error("Invalid date column");
    seen.add(day);
    columns.push({ day, column: index + 4 });
  });
  if (!columns.length) throw new Error("No shift dates in sheet");
  return columns;
}

function lastShiftRow(staffCells, staffNumber) {
  for (let index = staffCells.length - 1; index >= 0; index -= 1) {
    const value = staffCells[index][0].normalize("NFKC").trim();
    const number = value.match(/^(\d+)\s+/)?.[1];
    if (number === staffNumber) return index + 2;
  }
  return null;
}

function shiftJson(data) {
  return ContentService.createTextOutput(JSON.stringify(data)).setMimeType(ContentService.MimeType.JSON);
}
