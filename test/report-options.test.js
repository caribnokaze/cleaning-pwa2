const assert = require("node:assert/strict");
const test = require("node:test");
const path = require("node:path");
const { loadReportOptions, selectOptions } = require("../report-options");

test("loads staff and site choices from the Web report form", () => {
  const options = loadReportOptions(path.join(__dirname, "..", "index.html"));
  assert.ok(options.staff.length > 50);
  assert.ok(options.sites.length > 50);
  assert.ok(options.staff.every((item) => item.value && item.label));
  assert.ok(options.sites.every(Boolean));
});

test("decodes labels and removes disabled empty choices", () => {
  const html = '<select id="sample"><option value="" disabled>選択</option><option value="A&amp;B" label="01 A&amp;B"></option></select>';
  assert.deepEqual(selectOptions(html, "sample"), [{ value: "A&B", label: "01 A&B" }]);
});
