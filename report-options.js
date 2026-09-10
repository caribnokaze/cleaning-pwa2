const fs = require("fs");
const path = require("path");

function decodeHtmlAttribute(value = "") {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function attribute(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`, "i"));
  return decodeHtmlAttribute(match?.[1] ?? match?.[2] ?? "").trim();
}

function selectOptions(html, selectId) {
  const select = html.match(
    new RegExp(`<select\\b[^>]*\\bid=["']${selectId}["'][^>]*>([\\s\\S]*?)<\\/select>`, "i"),
  );
  if (!select) throw new Error(`Missing select: ${selectId}`);

  return [...select[1].matchAll(/<option\b[^>]*>[\s\S]*?<\/option>/gi)]
    .map(([tag]) => ({ value: attribute(tag, "value"), label: attribute(tag, "label") }))
    .filter((option) => option.value)
    .map((option) => ({ ...option, label: option.label || option.value }));
}

function loadReportOptions(indexPath = path.join(__dirname, "index.html")) {
  const html = fs.readFileSync(indexPath, "utf8");
  const staff = selectOptions(html, "staffOptions");
  const sites = selectOptions(html, "siteOptions").map((option) => option.value);
  if (!staff.length || !sites.length) throw new Error("Report options are empty");
  return { staff, sites };
}

module.exports = { loadReportOptions, selectOptions };
