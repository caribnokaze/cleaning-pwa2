const crypto = require("node:crypto");
const path = require("node:path");

const MONTH = /^20\d{2}-(0[1-9]|1[0-2])$/;

function staffIdentifier(option) {
  return option.label.normalize("NFKC").match(/^(\d+)\s+/)?.[1];
}

function validateReply(reply, month) {
  if (reply?.status === "no-sheet" || reply?.status === "no-response") {
    return { status: reply.status };
  }
  const [year, number] = month.split("-").map(Number);
  const daysInMonth = new Date(Date.UTC(year, number, 0)).getUTCDate();
  if (reply?.status !== "ok" || !Array.isArray(reply.days) || reply.days.length > daysInMonth) {
    throw new Error("Invalid shift response");
  }
  const seen = new Set();
  const days = reply.days.map(({ day, answer }) => {
    if (!Number.isInteger(day) || day < 1 || day > daysInMonth || seen.has(day) ||
        typeof answer !== "string" || !/^(?:\d{1,3}|休|未定)?$/.test(answer)) {
      throw new Error("Invalid shift day");
    }
    seen.add(day);
    return { day, answer };
  });
  return { status: "ok", days };
}

function createShiftRouter({ express, staff, hasWebSession, env = process.env, request = fetch }) {
  const router = express.Router();
  const numberedStaff = staff.filter(staffIdentifier);
  const staffByValue = new Map(numberedStaff.map((option) => [option.value, staffIdentifier(option)]));
  router.use((req, res, next) => {
    res.set("Cache-Control", "no-store");
    if (hasWebSession(req)) return next();
    if (req.path.startsWith("/api/")) return res.sendStatus(401);
    res.redirect("/login");
  });

  router.get("/", (_req, res) => res.sendFile(path.join(__dirname, "index.html")));
  router.get("/calendar.css", (_req, res) => res.sendFile(path.join(__dirname, "calendar.css")));
  router.get("/calendar.js", (_req, res) => res.sendFile(path.join(__dirname, "calendar.js")));
  router.get("/api/staff", (_req, res) => res.json(numberedStaff));

  async function fetchShiftData(query) {
    const { SHIFT_GAS_URL: url, SHIFT_GAS_SECRET: secret } = env;
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[\w-]+\/exec$/.test(url || "") || !secret || secret.length < 32) {
      throw Object.assign(new Error("GAS configuration missing"), { unconfigured: true });
    }
    const payload = JSON.stringify({ ...query, timestamp: Date.now(), nonce: crypto.randomUUID() });
    const signature = crypto.createHmac("sha256", secret).update(payload).digest("hex");
    const response = await request(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ payload, signature }),
      signal: AbortSignal.timeout(12000),
    });
    if (!response.ok) throw new Error("GAS request failed");
    return response.json();
  }

  function sendShiftError(res, error) {
    if (error.unconfigured) return res.status(503).json({ error: "希望シフトの連携が設定されていません。" });
    res.status(502).json({ error: "希望シフトを取得できませんでした。時間をおいて再読み込みしてください。" });
  }

  router.get("/api/months", async (_req, res) => {
    try {
      const reply = await fetchShiftData({ action: "months" });
      if (reply?.status === "denied") {
        const configuredMonths = (env.SHIFT_GAS_LEGACY_MONTHS || "").split(",").map((month) => month.trim());
        if (configuredMonths.every((month) => MONTH.test(month))) {
          res.set("X-Shift-Month-Source", "legacy");
          return res.json([...new Set(configuredMonths)].sort().slice(-3));
        }
      }
      if (reply?.status !== "ok" || !Array.isArray(reply.months) ||
          reply.months.some((month) => typeof month !== "string" || !MONTH.test(month))) {
        throw new Error("Invalid shift month list");
      }
      res.json([...new Set(reply.months)].sort().slice(-3));
    } catch (error) {
      sendShiftError(res, error);
    }
  });

  router.get("/api/calendar", async (req, res) => {
    const { month, staff: staffValue } = req.query;
    const number = staffByValue.get(staffValue);
    if (typeof month !== "string" || !MONTH.test(month) || !number) {
      return res.status(400).json({ error: "担当者と年月を選択してください。" });
    }
    try {
      const reply = await fetchShiftData({ month, number });
      if (reply?.status === "month-out-of-range") {
        return res.status(400).json({ error: "公開中の直近3か月から選択してください。" });
      }
      res.json(validateReply(reply, month));
    } catch (error) {
      sendShiftError(res, error);
    }
  });
  return router;
}

module.exports = { createShiftRouter };
