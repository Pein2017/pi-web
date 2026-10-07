import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { computeSessionStats } = await jiti.import("./session-stats.ts");

function usage(input, cacheRead, cost) {
  return {
    input,
    output: 0,
    cacheRead,
    cacheWrite: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
  };
}

test("live get_session_stats keeps SDK lifetime totals and adds the journal category breakdown", async () => {
  const entries = [
    { type: "message", id: "assistant", parentId: null, timestamp: "2026-01-01T00:00:00.000Z", message: { role: "assistant", provider: "test", model: "model", content: [], usage: usage(10, 4, 0.1) } },
    { type: "compaction", id: "compact", parentId: "assistant", timestamp: "2026-01-01T00:00:01.000Z", summary: "summary", firstKeptEntryId: "next", tokensBefore: 10, usage: usage(5, 0, 0.2) },
    { type: "usage", id: "unknown", parentId: "compact", timestamp: "2026-01-01T00:00:02.000Z", kind: "unrecognized", provider: "test", model: "model", usage: usage(2, 1, 0.05) },
    { type: "message", id: "tool-result", parentId: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "tool", content: [], usage: usage(3, 0, 0.02) } },
  ];
  const expected = computeSessionStats(entries);
  const sessionManager = {
    getEntries: () => entries,
    getSessionName: () => "live stats",
  };
  const inner = {
    sessionId: "live-session",
    sessionFile: undefined,
    sessionManager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    getSessionStats: () => ({
      userMessages: expected.userMessages,
      assistantMessages: expected.assistantMessages,
      toolCalls: expected.toolCalls,
      toolResults: expected.toolResults,
      totalMessages: expected.totalMessages,
      tokens: expected.tokens,
      cost: expected.cost,
    }),
    subscribe: () => () => {},
    dispose: () => {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  try {
    const live = await wrapper.send({ type: "get_session_stats" });
    assert.deepEqual(live.tokens, expected.tokens);
    assert.equal(live.cost, expected.cost);
    assert.deepEqual(live.usageBreakdown, expected.usageBreakdown);
    assert.equal(live.sessionName, "live stats");
  } finally {
    wrapper.destroy();
  }
});
