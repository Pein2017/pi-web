import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeSessionStats, mergeSessionStats } = await jiti.import("./session-stats.ts");
const demoStats = await jiti.import("../demo/lib/session-stats.ts");
const {
  buildSessionCacheRateRows,
  buildSessionUsageBreakdownRows,
  cacheUsageFraction,
  emptySessionUsageBreakdown,
  mergeSessionUsageBreakdown,
  sessionStatsMemoKey,
} = await jiti.import("./session-usage-breakdown.ts");
const { enLocale } = await jiti.import("./i18n/messages/en.ts");
const { zhCNLocale } = await jiti.import("./i18n/messages/zh-CN.ts");
const { zhTWLocale } = await jiti.import("./i18n/messages/zh-TW.ts");
const { enLocale: demoEnLocale } = await jiti.import("../demo/lib/i18n/messages/en.ts");
const { zhCNLocale: demoZhCNLocale } = await jiti.import("../demo/lib/i18n/messages/zh-CN.ts");
const { zhTWLocale: demoZhTWLocale } = await jiti.import("../demo/lib/i18n/messages/zh-TW.ts");

function usage(input, output, cacheRead, cacheWrite, cost) {
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

function message(id, parentId, role, u) {
  const body = role === "assistant"
    ? { role, provider: "test", model: "test-model", content: [{ type: "text", text: id }], usage: u }
    : { role, toolCallId: id, content: [{ type: "text", text: id }], usage: u };
  return { type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message: body };
}

function sumCategoryTokens(breakdown, field) {
  return ["inference", "compaction", "branchSummary", "cacheWarm", "other"]
    .reduce((sum, category) => sum + breakdown[category].tokens[field], 0);
}

function assertReconciles(stats) {
  for (const field of ["input", "output", "cacheRead", "cacheWrite"]) {
    assert.equal(sumCategoryTokens(stats.usageBreakdown, field), stats.tokens[field], `${field} must reconcile exactly`);
  }
  assert.equal(sumCategoryTokens(stats.usageBreakdown, "total"), stats.tokens.total, "category token totals must reconcile exactly");
  const categoryCost = ["inference", "compaction", "branchSummary", "cacheWarm", "other"]
    .reduce((sum, category) => sum + stats.usageBreakdown[category].cost, 0);
  assert.ok(Math.abs(categoryCost - stats.cost) <= 1e-9, "category cost must reconcile within USD 1e-9");
}

test("all usage kinds, including abandoned branches and tool-result usage, land in one category", () => {
  const entries = [
    message("assistant-main", "user-main", "assistant", usage(10, 5, 2, 1, 0.18)),
    { type: "compaction", id: "compact", parentId: "assistant-main", timestamp: "2026-01-01T00:00:01.000Z", summary: "summary", firstKeptEntryId: "user-next", tokensBefore: 50, usage: usage(3, 4, 5, 6, 0.1) },
    { type: "branch_summary", id: "branch-summary", parentId: "assistant-main", timestamp: "2026-01-01T00:00:02.000Z", fromId: "abandoned-assistant", summary: "side branch", usage: usage(7, 8, 9, 10, 0.2) },
    { type: "usage", id: "warm", parentId: "assistant-main", timestamp: "2026-01-01T00:00:03.000Z", kind: "cache_warm", provider: "test", model: "test-model", usage: usage(11, 12, 13, 14, 0.3) },
    { type: "usage", id: "future-kind", parentId: "assistant-main", timestamp: "2026-01-01T00:00:04.000Z", kind: "future_billed_usage", provider: "test", model: "test-model", usage: usage(15, 16, 17, 18, 0.4) },
    message("tool-result", "assistant-main", "toolResult", usage(19, 20, 21, 22, 0.5)),
    // This assistant entry is on a branch that is not the active leaf; lifetime stats still count it.
    message("abandoned-assistant", "different-branch", "assistant", usage(2, 1, 0, 0, 0.1)),
    { type: "context_edit", id: "edit", parentId: "assistant-main", timestamp: "2026-01-01T00:00:05.000Z", targetId: "assistant-main", replacement: null },
  ];
  const stats = computeSessionStats(entries);

  assert.deepEqual(stats.usageBreakdown.inference.tokens, { input: 12, output: 6, cacheRead: 2, cacheWrite: 1, total: 21 });
  assert.deepEqual(stats.usageBreakdown.compaction.tokens, { input: 3, output: 4, cacheRead: 5, cacheWrite: 6, total: 18 });
  assert.deepEqual(stats.usageBreakdown.branchSummary.tokens, { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, total: 34 });
  assert.deepEqual(stats.usageBreakdown.cacheWarm.tokens, { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, total: 50 });
  assert.deepEqual(stats.usageBreakdown.other.tokens, { input: 34, output: 36, cacheRead: 38, cacheWrite: 40, total: 148 });
  assert.equal(stats.usageBreakdown.other.cost, 0.9);
  assert.equal(stats.tokens.input, 67);
  assert.equal(stats.tokens.output, 66);
  assert.equal(stats.tokens.cacheRead, 67);
  assert.equal(stats.tokens.cacheWrite, 71);
  assert.ok(Math.abs(stats.cost - 1.78) <= 1e-9);
  assertReconciles(stats);

  const withoutContextEdit = computeSessionStats(entries.filter((entry) => entry.type !== "context_edit"));
  assert.deepEqual(stats.usageBreakdown, withoutContextEdit.usageBreakdown);
  assert.deepEqual(stats.tokens, withoutContextEdit.tokens);
  assert.equal(stats.cost, withoutContextEdit.cost);
  assert.deepEqual(demoStats.computeSessionStats(entries), stats);
});

test("incremental live merges add only message deltas and reload preserves lifetime categories", () => {
  const initialEntries = [
    message("assistant-old", "old-user", "assistant", usage(10, 5, 2, 1, 0.18)),
    { type: "compaction", id: "compact", parentId: "assistant-old", timestamp: "2026-01-01T00:00:01.000Z", summary: "summary", firstKeptEntryId: "next-user", tokensBefore: 20, usage: usage(2, 1, 0, 3, 0.07) },
    { type: "usage", id: "warm", parentId: "compact", timestamp: "2026-01-01T00:00:02.000Z", kind: "cache_warm", provider: "test", model: "test-model", usage: usage(0, 0, 8, 2, 0.03) },
    message("tool-old", "assistant-old", "toolResult", usage(1, 0, 0, 0, 0.02)),
  ];
  const loadedMessages = [
    { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "loaded" }], usage: usage(10, 5, 2, 1, 0.18) },
    { role: "toolResult", toolCallId: "tool-old", content: [], usage: usage(1, 0, 0, 0, 0.02) },
  ];
  const addedAssistant = { role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "new" }], usage: usage(4, 3, 2, 1, 0.11) };
  const addedTool = { role: "toolResult", toolCallId: "tool-new", content: [], usage: usage(0, 0, 0, 5, 0.04) };
  const currentMessages = [...loadedMessages, addedAssistant, addedTool];
  const fileStats = computeSessionStats(initialEntries);
  const merged = mergeSessionStats(fileStats, loadedMessages, currentMessages);
  const reloaded = computeSessionStats([
    ...initialEntries,
    { type: "message", id: "assistant-new", parentId: "compact", timestamp: "2026-01-01T00:00:03.000Z", message: addedAssistant },
    { type: "message", id: "tool-new", parentId: "assistant-new", timestamp: "2026-01-01T00:00:04.000Z", message: addedTool },
  ]);

  for (const category of ["inference", "compaction", "branchSummary", "cacheWarm", "other"]) {
    assert.deepEqual(merged.usageBreakdown[category].tokens, reloaded.usageBreakdown[category].tokens);
    assert.ok(Math.abs(merged.usageBreakdown[category].cost - reloaded.usageBreakdown[category].cost) <= 1e-9);
  }
  assert.deepEqual(merged.tokens, reloaded.tokens);
  assert.ok(Math.abs(merged.cost - reloaded.cost) <= 1e-9);
  assert.equal(merged.usageBreakdown.compaction.cost, fileStats.usageBreakdown.compaction.cost);
  assert.equal(merged.usageBreakdown.cacheWarm.cost, fileStats.usageBreakdown.cacheWarm.cost);
  assert.equal(merged.usageBreakdown.inference.tokens.input, fileStats.usageBreakdown.inference.tokens.input + 4);
  assert.equal(merged.usageBreakdown.other.tokens.cacheWrite, fileStats.usageBreakdown.other.tokens.cacheWrite + 5);
  assertReconciles(merged);
  assert.deepEqual(mergeSessionStats(reloaded, currentMessages, currentMessages), reloaded, "reload with unchanged messages must not duplicate usage");
});

test("replacement live context with unchanged aggregate preserves baseline categories and totals", () => {
  const assistant = { role: "assistant", provider: "test", model: "test-model", content: [], usage: usage(10, 0, 0, 0, 0.1) };
  const toolResult = { role: "toolResult", toolCallId: "tool", content: [], usage: usage(10, 0, 0, 0, 0.1) };
  const base = computeSessionStats([message("assistant", null, "assistant", assistant.usage)]);
  const merged = mergeSessionStats(base, [assistant], [toolResult]);

  assert.equal(merged.tokens.input, 10);
  assert.equal(merged.cost, 0.1);
  assert.deepEqual(merged.usageBreakdown, base.usageBreakdown);
  assertReconciles(merged);
  const demoBase = demoStats.computeSessionStats([message("assistant", null, "assistant", assistant.usage)]);
  const demoMerged = demoStats.mergeSessionStats(demoBase, [assistant], [toolResult]);
  assert.deepEqual(demoMerged.usageBreakdown, demoBase.usageBreakdown);
  assertReconciles(demoMerged);

  const reducedAfterCompaction = mergeSessionStats(base, [assistant], []);
  assert.deepEqual(reducedAfterCompaction.tokens, base.tokens);
  assert.deepEqual(reducedAfterCompaction.usageBreakdown, base.usageBreakdown);
  assert.equal(reducedAfterCompaction.cost, base.cost);
});

test("net cross-category append keeps an unambiguous class and ambiguous net deltas go to other", () => {
  const assistantBefore = { role: "assistant", provider: "test", model: "test-model", content: [], usage: usage(10, 0, 0, 0, 0.1) };
  const base = computeSessionStats([message("assistant", null, "assistant", assistantBefore.usage)]);
  const assistantAfter = { ...assistantBefore, usage: usage(8, 0, 0, 0, 0.08) };
  const toolAfter = { role: "toolResult", toolCallId: "tool", content: [], usage: usage(5, 0, 0, 0, 0.05) };
  const netOther = mergeSessionStats(base, [assistantBefore], [assistantAfter, toolAfter]);
  assert.equal(netOther.tokens.input, 13);
  assert.equal(netOther.usageBreakdown.inference.tokens.input, 10);
  assert.equal(netOther.usageBreakdown.other.tokens.input, 3);
  assert.equal(netOther.usageBreakdown.inference.cost, 0.1);
  assert.ok(Math.abs(netOther.usageBreakdown.other.cost - 0.03) <= 1e-9);
  assertReconciles(netOther);

  const file = emptySessionUsageBreakdown();
  file.inference.tokens.input = 100;
  file.inference.tokens.total = 100;
  file.inference.cost = 1;
  const loaded = emptySessionUsageBreakdown();
  loaded.inference.tokens.input = 10;
  loaded.inference.tokens.total = 10;
  loaded.inference.cost = 0.1;
  const current = emptySessionUsageBreakdown();
  current.inference.tokens.input = 8;
  current.inference.tokens.total = 8;
  current.inference.cost = 0.08;
  current.compaction.tokens.input = 3;
  current.compaction.tokens.total = 3;
  current.compaction.cost = 0.03;
  current.branchSummary.tokens.input = 2;
  current.branchSummary.tokens.total = 2;
  current.branchSummary.cost = 0.02;
  const ambiguous = mergeSessionUsageBreakdown(file, loaded, current, {
    tokens: { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 },
    cost: 0.03,
  });
  assert.equal(ambiguous.inference.tokens.input, 100);
  assert.equal(ambiguous.compaction.tokens.input, 0);
  assert.equal(ambiguous.branchSummary.tokens.input, 0);
  assert.equal(ambiguous.other.tokens.input, 3);
  assert.equal(ambiguous.inference.cost, 1);
  assert.equal(ambiguous.compaction.cost, 0);
  assert.equal(ambiguous.branchSummary.cost, 0);
  assert.ok(Math.abs(ambiguous.other.cost - 0.03) <= 1e-9);
});

test("cache fractions exclude output, include cache writes, and represent an empty denominator as unavailable", () => {
  assert.equal(cacheUsageFraction({ tokens: { input: 3, output: 10_000, cacheRead: 1, cacheWrite: 2, total: 10_006 } }), 1 / 6);
  assert.equal(cacheUsageFraction({ tokens: { input: 0, output: 99, cacheRead: 0, cacheWrite: 4, total: 103 } }), 0);
  assert.equal(cacheUsageFraction({ tokens: { input: 0, output: 99, cacheRead: 0, cacheWrite: 0, total: 99 } }), null);

  const empty = computeSessionStats([]);
  const translate = (key) => key;
  const rates = buildSessionCacheRateRows(empty, translate);
  assert.deepEqual(rates.map((row) => row.value), ["session.usage.unavailable", "session.usage.unavailable", "session.usage.unavailable"]);
});

test("ordinary, maintenance, and other presentation rows localize amount/cost and refresh on breakdown-only changes", () => {
  const stats = computeSessionStats([
    message("ordinary", null, "assistant", usage(3, 100, 1, 2, 0.3)),
    { type: "compaction", id: "maintenance", parentId: "ordinary", timestamp: "2026-01-01T00:00:01.000Z", summary: "summary", firstKeptEntryId: "next", tokensBefore: 1, usage: usage(2, 0, 0, 1, 0.2) },
    { type: "usage", id: "warm", parentId: "maintenance", timestamp: "2026-01-01T00:00:02.000Z", kind: "cache_warm", provider: "test", model: "test-model", usage: usage(0, 0, 0, 1, 0.1) },
    { type: "usage", id: "unknown", parentId: "warm", timestamp: "2026-01-01T00:00:03.000Z", kind: "unknown", provider: "test", model: "test-model", usage: usage(1, 0, 0, 0, 0.05) },
  ]);
  const locales = [enLocale, zhCNLocale, zhTWLocale, demoEnLocale, demoZhCNLocale, demoZhTWLocale];
  for (const locale of locales) {
    const translate = (key) => locale.messages[key] ?? key;
    const rows = buildSessionUsageBreakdownRows(stats.usageBreakdown, translate, locale.id);
    const rates = buildSessionCacheRateRows(stats, translate);
    assert.equal(rows.find((row) => row.key === "inference").label, locale.messages["session.usage.inference"]);
    assert.equal(rows.find((row) => row.key === "maintenance").label, locale.messages["session.usage.maintenance"]);
    assert.equal(rows.find((row) => row.key === "other").label, locale.messages["session.usage.other"]);
    assert.match(rows.find((row) => row.key === "inference").value, /106/);
    assert.match(rows.find((row) => row.key === "inference").value, /\$0\.3000/);
    assert.equal(rates[0].label, locale.messages["session.cacheHitRate"]);
    assert.equal(rates[1].label, locale.messages["session.usage.ordinaryCacheHitRate"]);
    assert.equal(rates[2].label, locale.messages["session.usage.maintenanceCacheHitRate"]);
    assert.deepEqual(rates.map((row) => row.value), ["9.1%", "16.7%", "0.0%"]);
  }

  const memoInput = {
    sessionId: "session",
    ...stats,
  };
  const originalKey = sessionStatsMemoKey(memoInput);
  const originalRows = buildSessionUsageBreakdownRows(stats.usageBreakdown, (key) => key, "en");
  const reassigned = structuredClone(memoInput);
  const ordinary = reassigned.usageBreakdown.inference;
  reassigned.usageBreakdown.inference = reassigned.usageBreakdown.other;
  reassigned.usageBreakdown.other = ordinary;
  assert.deepEqual(reassigned.tokens, memoInput.tokens, "category-only reclassification leaves lifetime totals fixed");
  assert.notEqual(sessionStatsMemoKey(reassigned), originalKey, "ChatWindow memo key includes categorized amounts");
  const reassignedRows = buildSessionUsageBreakdownRows(reassigned.usageBreakdown, (key) => key, "en");
  assert.notDeepEqual(reassignedRows, originalRows, "the AppShell-consumed rows reflect category-only updates");
});

test("ChatWindow memo invalidates on observed TPS-only updates with fixed lifetime totals", () => {
  const stats = { sessionId: "session", ...computeSessionStats([]) };
  const initial = sessionStatsMemoKey(stats);
  const measured = { ...stats, observedDecodeTps: {
    tps: 50, outputTokens: 100, elapsedMs: 2000, measuredResponses: 1, trackedResponses: 1,
    groups: [{ provider: "test", modelId: "model", tps: 50, outputTokens: 100, elapsedMs: 2000, measuredResponses: 1, trackedResponses: 1 }],
  } };
  assert.deepEqual(measured.tokens, stats.tokens);
  assert.notEqual(sessionStatsMemoKey(measured), initial, "AppShell must receive newly available timing even without token/cost changes");
  const timingUpdate = structuredClone(measured);
  timingUpdate.observedDecodeTps.tps = 40;
  timingUpdate.observedDecodeTps.elapsedMs = 2500;
  timingUpdate.observedDecodeTps.groups[0].tps = 40;
  timingUpdate.observedDecodeTps.groups[0].elapsedMs = 2500;
  assert.notEqual(sessionStatsMemoKey(timingUpdate), sessionStatsMemoKey(measured));
  const coverageUpdate = structuredClone(measured);
  coverageUpdate.observedDecodeTps.groups[0].trackedResponses = 2;
  assert.notEqual(sessionStatsMemoKey(coverageUpdate), sessionStatsMemoKey(measured), "model-specific coverage must also invalidate the memo");
});

test("chronological cost remains authoritative while category regrouping stays within USD 1e-9", () => {
  const stats = computeSessionStats([
    { type: "usage", id: "warm", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", kind: "cache_warm", provider: "test", model: "test-model", usage: usage(1, 0, 0, 0, 0.1) },
    { type: "compaction", id: "compact", parentId: "warm", timestamp: "2026-01-01T00:00:01.000Z", summary: "summary", firstKeptEntryId: "next", tokensBefore: 1, usage: usage(1, 0, 0, 0, 0.2) },
    message("ordinary", "compact", "assistant", usage(1, 0, 0, 0, 0.3)),
  ]);
  const chronological = 0 + 0.1 + 0.2 + 0.3;
  const categorized = stats.usageBreakdown.inference.cost + stats.usageBreakdown.compaction.cost + stats.usageBreakdown.cacheWarm.cost;
  assert.equal(stats.cost, chronological, "the pre-existing chronological lifetime cost is unchanged");
  assert.notEqual(categorized, chronological, "fixture exercises floating regrouping");
  assert.ok(Math.abs(categorized - stats.cost) <= 1e-9);
  assertReconciles(stats);
});
