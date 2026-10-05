import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/automation-page.ts", import.meta.url), "utf8");
const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("a run's worklog link addresses the chats view, not the page it was rendered on", () => {
  assert.match(source, /class="cron-run-link" href=\$\{deepLinkPath\(UI_BASE, "chats", run\.sessionId\)\}/);
  assert.doesNotMatch(source, /location\.pathname\}\?session=/);
});

test("a cron row is a real link to its own path", () => {
  assert.match(
    source,
    /<a\s+class="cron-row-main"\s+href=\$\{deepLinkPath\(UI_BASE, options\.kind, null, null, c\.id\)\}/,
  );
});

test("cron index rows keep details and raw schedules out of the summary", () => {
  const row = source.slice(
    source.indexOf("function automationPageRow"),
    source.indexOf("function automationRowActions"),
  );
  assert.doesNotMatch(row, /cronPreview|cronScheduleSummary/);
  assert.match(row, /options\.runSummary\(c\)/);
});

test("cron index keeps only search in its header controls", () => {
  const page = source.slice(
    source.indexOf("function drawAutomationsPage"),
    source.indexOf("function setAutomationTab"),
  );
  assert.doesNotMatch(page, /onRefresh|label: "New cron"/);
  assert.match(page, /placeholder: `Search \$\{options\.kind\}`/);
});

test("reopening a cron refreshes recent runs without a manual refresh control", () => {
  assert.match(source, /const shouldRefreshRuns = opts\.refreshRuns \|\| activeAutomationId !== c\.id;/);
  assert.match(source, /openAutomation\(c, \{ refreshRuns: true \}\)/);
});

test("modified clicks fall through to the browser so open-in-tab and save-link still work", () => {
  const deepLink = readFileSync(new URL("../src/deep-link.ts", import.meta.url), "utf8");
  assert.match(deepLink, /e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0/);
  assert.match(source, /if \(!isPlainLeftClick\(event\)\) return;/);
});

test("opening a cron from the list pushes history, so Back returns to the list", () => {
  assert.match(source, /openAutomation\(c, \{ push: true \}\)/);
  assert.match(source, /if \(push\) history\.pushState\(null, "", next\);\s+else history\.replaceState/);
  assert.match(shell, /addEventListener\("popstate"[\s\S]*?routeCronsHistory\(item\)/);
});

test("a failed load is never reported as a missing cron", () => {
  assert.match(source, /const loaded = await refreshAutomations/);
  assert.match(source, /if \(!loaded\) return drawAutomationsPage\(\);/);
  const body = source.slice(source.indexOf("async function renderAutomationsPage"));
  assert.ok(body.indexOf("if (!loaded)") < body.indexOf("wasn't found"));
});

test("a pending deep-linked cron is consumed even when the view changed mid-load", () => {
  const body = source.slice(source.indexOf("async function renderAutomationsPage"));
  const consume = body.indexOf("pendingAutomationId = null");
  const guard = body.indexOf("appState.currentView !== options.kind) return", body.indexOf("await refreshAutomations"));
  assert.ok(consume !== -1 && guard !== -1 && consume < guard);
});
