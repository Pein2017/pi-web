import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const loader = createJiti(import.meta.url);
const { projectSubagentObservation, readSubagentObservation } = await loader.import("./subagent-observation.ts");
const { subagentToolDetails } = await loader.import("./subagent-extension.ts");
const custom = (id, customType, data = {}) => ({ id, parentId: null, timestamp: "2026-10-06T00:00:00Z", type: "custom", customType, data });
const usage = (input) => ({ input, output: 2, cacheRead: 8, cacheWrite: 0, cost: { total: 0.1 } });
const assistant = (id, overrides = {}) => ({ id, parentId: null, timestamp: "2026-10-06T00:00:00Z", type: "message", message: {
  role: "assistant", content: [{ type: "text", text: "secret transcript never copied" }], provider: "openai", model: "selected", usage: usage(10), stopReason: "stop", ...overrides,
} });
const run = { sessionPath: "/session.jsonl", status: "completed", completedAt: "second", worktreePath: "/worktree" };

test("resumed invocation excludes earlier usage, includes auxiliary billed records, and bounds metadata", () => {
  const entries = [custom("meta", "pi-web:subagent"), assistant("old", { usage: usage(1000) }),
    custom("old-end", "pi-web:subagent-result", { completedAt: "first" }),
    custom("queued", "pi-web:subagent-status", { status: "queued" }),
    custom("running", "pi-web:subagent-status", { status: "running" }),
    assistant("new", { responseModel: "actual", thinkingLevel: "high", providerThinkingLevel: "native-high", rawStopReason: "end_turn" }),
    { id: "warm", type: "usage", usage: usage(3) },
    { id: "compact", type: "compaction", usage: usage(4) },
    { id: "tool", type: "message", message: { role: "toolResult", toolCallId: "x", content: [], usage: usage(5), details: { fullOutputPath: "/raw.txt" } } },
    custom("end", "pi-web:subagent-result", { completedAt: "second" })];
  const result = projectSubagentObservation(entries, run);
  assert.equal(result.scope, "lifecycle-inferred");
  assert.equal(result.firstEntryId, "queued");
  assert.equal(result.lastEntryId, "end");
  assert.equal(result.recordedStats.tokens.input, 22);
  assert.equal(result.recordedStats.tokens.cacheRead, 32);
  assert.equal(result.assistantResponses, 1);
  assert.equal(result.turnCount, null);
  assert.equal(result.responses[0].selectedModel, "selected");
  assert.equal(result.responses[0].responseModel, "actual");
  assert.equal(result.responses[0].providerThinkingLevel, "native-high");
  assert.equal(result.termination.rawStopReason, "end_turn");
  assert.equal(result.termination.cause, null);
  assert.ok(result.artifacts.some((artifact) => artifact.path === "/raw.txt" && artifact.entryId === "tool"));
  assert.ok(!JSON.stringify(result).includes("secret transcript"));
});

test("unknown model routing and missing lifecycle evidence do not become fake facts", () => {
  const firstRun = { ...run, completedAt: "first" };
  const result = projectSubagentObservation([custom("meta", "pi-web:subagent"), assistant("answer"), custom("end", "pi-web:subagent-result", { completedAt: "first" })], firstRun);
  assert.equal(result.responses[0].responseModel, null);
  assert.equal(result.responses[0].thinkingLevel, null);
  assert.equal(projectSubagentObservation([assistant("answer")], firstRun).scope, "unavailable");
  assert.equal(projectSubagentObservation([custom("end", "pi-web:subagent-result", { completedAt: "first" })], firstRun).recordedStats, undefined);
});

test("only explicit runtime telemetry supplies exact turns and budget termination", () => {
  const entries = [custom("meta", "pi-web:subagent"), assistant("answer"), custom("end", "pi-web:subagent-result", {
    completedAt: "second", telemetry: { turnCount: 4, turnCountBasis: "turn_end", terminationReason: "max-turns" },
  })];
  const result = projectSubagentObservation(entries, run);
  assert.equal(result.assistantResponses, 1);
  assert.equal(result.turnCount, 4);
  assert.equal(result.turnCountBasis, "turn_end");
  assert.equal(result.termination.runtimeStatus, "completed");
  assert.equal(result.termination.cause, "max-turns");
  entries[2].data.telemetry = { turnCount: -1, turnCountBasis: "guessed", terminationReason: "invented" };
  assert.equal(projectSubagentObservation(entries, run).turnCount, null);
  assert.equal(projectSubagentObservation(entries, run).termination.cause, null);
});

test("terminal tool details consume a real SDK-readable journal without transcript dumps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-observation-"));
  const sessionPath = join(dir, "child.jsonl");
  try {
    const entries = [
      { type: "session", version: 3, id: "child", cwd: dir, timestamp: "2026-10-06T00:00:00Z" },
      custom("meta", "pi-web:subagent"), assistant("answer", { responseModel: "actual" }),
      custom("end", "pi-web:subagent-result", { completedAt: "second" }),
    ];
    await writeFile(sessionPath, entries.map(entry => JSON.stringify(entry)).join("\n") + "\n");
    const details = subagentToolDetails({ ...run, sessionPath, sessionId: "child", profile: "test", description: "bounded", runInBackground: false, createdAt: "first" });
    assert.equal(details.kind, "pi-web-subagent");
    assert.equal(details.sessionId, "child");
    assert.equal(details.observation.recordedStats.tokens.input, 10);
    assert.equal(details.observation.responses[0].responseModel, "actual");
    assert.equal(readSubagentObservation({ ...run, sessionPath, status: "running" }), undefined);
    assert.equal(readSubagentObservation({ ...run, sessionPath: join(dir, "missing") }), undefined);
    assert.ok(!JSON.stringify(details).includes("secret transcript"));
    await truncate(sessionPath, 17 * 1024 * 1024);
    const telemetry = { turnCount: 4, turnCountBasis: "turn_end", terminationReason: "max-turns" };
    const bounded = subagentToolDetails({ ...run, sessionPath, sessionId: "child", telemetry });
    assert.equal(bounded.observation, undefined, "oversized journals must not be scanned");
    assert.deepEqual(bounded.telemetry, telemetry, "runtime metadata survives the scan budget");
    assert.equal(bounded.sessionPath, sessionPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("model variants and raw artifact pointers cap output without truncating accounting", () => {
  const entries = [custom("meta", "pi-web:subagent")];
  for (let i = 0; i < 30; i++) {
    entries.push(assistant(`a${i}`, { responseModel: `model-${i}` }));
    entries.push({ id: `b${i}`, type: "message", message: { role: "bashExecution", output: "very large raw output", fullOutputPath: `/raw-${i}` } });
  }
  entries.push(custom("end", "pi-web:subagent-result", { completedAt: "second" }));
  const result = projectSubagentObservation(entries, run);
  assert.equal(result.responses.length, 8);
  assert.equal(result.responsesTruncated, true);
  assert.equal(result.artifacts.length, 16);
  assert.equal(result.artifactsTruncated, true);
  assert.equal(result.assistantResponses, 30);
  assert.equal(result.recordedStats.tokens.input, 300);
});
