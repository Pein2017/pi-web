import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeObservedDecodeTps, OBSERVED_DECODE_TPS_ENTRY_TYPE, ObservedDecodeTpsEventTracker } = await jiti.import("./session-decode-tps.ts");

function assistant(id, provider = "provider-a", modelId = "model-a") {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-10-01T00:00:00.000Z",
    message: { role: "assistant", provider, model: modelId, content: [] },
  };
}

function telemetry(id, assistantEntryId, data) {
  return {
    type: "custom",
    id,
    parentId: assistantEntryId,
    timestamp: "2026-10-01T00:00:01.000Z",
    customType: OBSERVED_DECODE_TPS_ENTRY_TYPE,
    data,
  };
}

function record(assistantEntryId, over = {}) {
  return {
    version: 1,
    assistantEntryId,
    provider: "provider-a",
    modelId: "model-a",
    status: "measured",
    outputDeltaCount: 3,
    outputTokens: 100,
    elapsedMs: 2000,
    ...over,
  };
}

test("aggregates total output tokens over total decode intervals, not mean response rate", () => {
  const entries = [
    assistant("a1"),
    assistant("a2"),
    telemetry("t1", "a1", record("a1", { outputTokens: 100, elapsedMs: 2000 })),
    telemetry("t2", "a2", record("a2", { outputTokens: 300, elapsedMs: 3000 })),
  ];

  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, 80);
  assert.equal(summary.outputTokens, 400);
  assert.equal(summary.elapsedMs, 5000);
  assert.equal(summary.measuredResponses, 2);
  assert.equal(summary.trackedResponses, 2);
  assert.equal(summary.groups.length, 1);
  assert.equal(summary.groups[0].tps, 80);
});

test("keeps provider/model rates separate while retaining one session-wide aggregate", () => {
  const entries = [
    assistant("a1", "provider-a", "model-a"),
    assistant("a2", "provider-b", "model-b"),
    telemetry("t1", "a1", record("a1", { outputTokens: 100, elapsedMs: 2000 })),
    telemetry("t2", "a2", record("a2", {
      provider: "provider-b",
      modelId: "model-b",
      outputTokens: 300,
      elapsedMs: 3000,
    })),
  ];

  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, 80);
  assert.deepEqual(summary.groups.map(({ provider, modelId, tps }) => ({ provider, modelId, tps })), [
    { provider: "provider-a", modelId: "model-a", tps: 50 },
    { provider: "provider-b", modelId: "model-b", tps: 100 },
  ]);
});

test("reports tracked-but-unmeasurable responses without inventing a zero rate", () => {
  const entries = [
    assistant("a1"),
    assistant("a2"),
    telemetry("t1", "a1", record("a1")),
    telemetry("t2", "a2", {
      version: 1,
      assistantEntryId: "a2",
      provider: "provider-a",
      modelId: "model-a",
      status: "excluded",
      outputDeltaCount: 0,
      exclusionReason: "not-streamed",
    }),
  ];

  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, 50);
  assert.equal(summary.measuredResponses, 1);
  assert.equal(summary.trackedResponses, 2);
});

test("aggregates measured responses from every branch in the session log", () => {
  const original = assistant("a1");
  const alternate = assistant("a2");
  const entries = [
    { ...original, parentId: "u1" },
    telemetry("t1", "a1", record("a1", { outputTokens: 100, elapsedMs: 2000 })),
    { ...alternate, parentId: "u2" },
    telemetry("t2", "a2", record("a2", { outputTokens: 300, elapsedMs: 3000 })),
  ];

  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, 80);
  assert.equal(summary.measuredResponses, 2);
  assert.equal(summary.trackedResponses, 2);
});

test("returns an unavailable summary when all tracked responses are excluded", () => {
  const entries = [
    assistant("a1"),
    telemetry("t1", "a1", {
      version: 1,
      assistantEntryId: "a1",
      provider: "provider-a",
      modelId: "model-a",
      status: "excluded",
      outputDeltaCount: 1,
      exclusionReason: "insufficient-deltas",
    }),
  ];
  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, null);
  assert.equal(summary.measuredResponses, 0);
  assert.equal(summary.trackedResponses, 1);
  assert.equal(summary.groups[0].tps, null);
});

test("does not infer metrics for legacy sessions without telemetry entries", () => {
  assert.equal(computeObservedDecodeTps([assistant("a1")]), undefined);
});

test("ignores orphan, duplicate, unsupported, and malformed telemetry records", () => {
  const entries = [
    assistant("a1"),
    assistant("a2"),
    telemetry("t1", "a1", record("a1")),
    telemetry("duplicate", "a1", record("a1", { outputTokens: 500, elapsedMs: 1 })),
    telemetry("orphan", "missing", record("missing")),
    telemetry("unsupported", "a2", record("a2", { version: 2 })),
    telemetry("invalid-duration", "a2", record("a2", { elapsedMs: 0 })),
  ];

  const summary = computeObservedDecodeTps(entries);
  assert.equal(summary.tps, 50);
  assert.equal(summary.outputTokens, 100);
  assert.equal(summary.measuredResponses, 1);
  assert.equal(summary.trackedResponses, 1);
});

test("event tracker measures non-empty text, thinking, and tool-call deltas across SDK message copies", () => {
  const times = [100, 140, 200];
  const tracker = new ObservedDecodeTpsEventTracker(() => times.shift());
  const message = {
    role: "assistant",
    provider: "provider-a",
    model: "model-a",
    usage: { output: 50 },
    stopReason: "stop",
  };
  tracker.observe({ type: "message_start", message: { ...message } });
  tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "text_delta", delta: "hello" } });
  tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "text_delta", delta: "" } });
  tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "thinking_delta", delta: "reason" } });
  tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "toolcall_delta", delta: "{}" } });
  tracker.observe({ type: "message_end", message });

  const records = tracker.drain([{
    type: "message",
    id: "assistant-entry",
    parentId: null,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  }]);
  assert.deepEqual(records, [{
    version: 1,
    assistantEntryId: "assistant-entry",
    provider: "provider-a",
    modelId: "model-a",
    status: "measured",
    outputDeltaCount: 3,
    outputTokens: 50,
    elapsedMs: 100,
  }]);
});

test("event tracker records completed ineligible outputs and discards unfinished or ambiguous messages", () => {
  const tracker = new ObservedDecodeTpsEventTracker(() => 10);
  const oneDelta = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "stop" };
  const notStreamed = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "stop" };
  const interrupted = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "aborted" };
  const unfinished = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "aborted" };

  tracker.observe({ type: "message_start", message: { ...oneDelta } });
  tracker.observe({ type: "message_update", message: oneDelta, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  tracker.observe({ type: "message_end", message: oneDelta });
  tracker.observe({ type: "message_start", message: { ...notStreamed } });
  tracker.observe({ type: "message_end", message: notStreamed });
  tracker.observe({ type: "message_start", message: { ...interrupted } });
  tracker.observe({ type: "message_update", message: interrupted, assistantMessageEvent: { type: "text_delta", delta: "x" } });
  tracker.observe({ type: "message_update", message: interrupted, assistantMessageEvent: { type: "text_delta", delta: "y" } });
  tracker.observe({ type: "message_end", message: interrupted });
  tracker.observe({ type: "message_start", message: { ...unfinished } });
  tracker.observe({ type: "message_update", message: { ...unfinished }, assistantMessageEvent: { type: "text_delta", delta: "never ends" } });

  const entries = [oneDelta, notStreamed, interrupted].map((message, index) => ({
    type: "message",
    id: `entry-${index}`,
    parentId: null,
    timestamp: "2026-10-01T00:00:00.000Z",
    message,
  }));
  entries.push({ ...entries[0], id: "duplicate-entry" });
  const records = tracker.drain(entries);
  assert.deepEqual(records.map(({ assistantEntryId, status, exclusionReason }) => ({ assistantEntryId, status, exclusionReason })), [
    { assistantEntryId: "entry-1", status: "excluded", exclusionReason: "not-streamed" },
    { assistantEntryId: "entry-2", status: "excluded", exclusionReason: "interrupted" },
  ]);
  assert.equal(tracker.drain(entries).length, 0);
});

test("overlapping assistant starts invalidate timing until drain; later valid lifecycle recovers", () => {
  const tracker = new ObservedDecodeTpsEventTracker(() => 10);
  const a = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "stop" };
  const b = { ...a };
  const entries = [a, b].map((message, index) => ({ ...assistant(`entry-${index}`), message }));
  tracker.observe({ type: "message_start", message: { ...a } });
  tracker.observe({ type: "message_update", message: { ...a }, assistantMessageEvent: { type: "text_delta", delta: "a" } });
  tracker.observe({ type: "message_start", message: { ...b } });
  tracker.observe({ type: "message_update", message: { ...b }, assistantMessageEvent: { type: "text_delta", delta: "b" } });
  tracker.observe({ type: "message_end", message: a });
  tracker.observe({ type: "message_end", message: b });
  // A third start cannot resolve which preceding lifecycle was incomplete.
  tracker.observe({ type: "message_start", message: { ...a } });
  tracker.observe({ type: "message_end", message: a });
  assert.deepEqual(tracker.drain(entries), []);
  tracker.observe({ type: "message_start", message: { ...b } });
  tracker.observe({ type: "message_end", message: b });
  assert.equal(tracker.drain(entries)[0].exclusionReason, "not-streamed");
});

test("orphan updates/ends, reused final objects, and nonidentical persisted messages cannot synthesize timing", () => {
  let clock = 0;
  const tracker = new ObservedDecodeTpsEventTracker(() => ++clock);
  const message = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 5 }, stopReason: "stop" };
  const entry = { ...assistant("a1"), message };
  tracker.observe({ type: "message_update", message, assistantMessageEvent: { type: "text_delta", delta: "orphan" } });
  tracker.observe({ type: "message_end", message });
  assert.deepEqual(tracker.drain([entry]), []);
  for (let i = 0; i < 2; i++) {
    tracker.observe({ type: "message_start", message: { ...message } });
    tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "text_delta", delta: "first" } });
    tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "text_delta", delta: "last" } });
    tracker.observe({ type: "message_end", message });
  }
  assert.deepEqual(tracker.drain([entry]), []);
  tracker.observe({ type: "message_start", message: { ...message } });
  tracker.observe({ type: "message_end", message });
  assert.deepEqual(tracker.drain([{ ...entry, message: { ...message } }]), []);
});

test("sequential responses exclude tool/idle gaps and keep identical-content final objects distinct", () => {
  const times = [100, 120, 10000, 10080];
  const tracker = new ObservedDecodeTpsEventTracker(() => times.shift());
  const message = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: 10 }, stopReason: "stop" };
  const entries = [message, { ...message }].map((message, index) => ({ ...assistant(`a${index}`), message }));
  for (const entry of entries) {
    tracker.observe({ type: "message_start", message: { ...entry.message } });
    tracker.observe({ type: "message_update", message: { ...entry.message }, assistantMessageEvent: { type: "text_delta", delta: "first" } });
    tracker.observe({ type: "message_update", message: { ...entry.message }, assistantMessageEvent: { type: "text_delta", delta: "last" } });
    tracker.observe({ type: "message_end", message: entry.message });
    tracker.observe({ type: "tool_execution_start", toolCallId: "irrelevant" });
    tracker.observe({ type: "tool_execution_end", toolCallId: "irrelevant" });
  }
  assert.deepEqual(tracker.drain(entries).map(({ assistantEntryId, outputTokens, elapsedMs }) => ({ assistantEntryId, outputTokens, elapsedMs })), [
    { assistantEntryId: "a0", outputTokens: 10, elapsedMs: 20 },
    { assistantEntryId: "a1", outputTokens: 10, elapsedMs: 80 },
  ]);
});

test("completed copied-message lifecycles retain all measurement exclusion rules", () => {
  const cases = [
    { deltas: 0, times: [], output: 10, reason: "not-streamed" },
    { deltas: 1, times: [1], output: 10, reason: "insufficient-deltas" },
    { deltas: 2, times: [1, 2], output: undefined, reason: "missing-output-usage" },
    { deltas: 2, times: [1, 2], output: 0, reason: "missing-output-usage" },
    { deltas: 2, times: [1, 1], output: 10, reason: "invalid-duration" },
    { deltas: 2, times: [2, 1], output: 10, reason: "invalid-duration" },
    { deltas: 2, times: [1, 2], output: 10, stopReason: "aborted", reason: "interrupted" },
    { deltas: 2, times: [1, 2], output: 10, stopReason: "error", reason: "interrupted" },
  ];
  for (const item of cases) {
    const tracker = new ObservedDecodeTpsEventTracker(() => item.times.shift());
    const message = { role: "assistant", provider: "provider-a", model: "model-a", usage: { output: item.output }, stopReason: item.stopReason ?? "stop" };
    tracker.observe({ type: "message_start", message: { ...message } });
    for (let i = 0; i < item.deltas; i++) tracker.observe({ type: "message_update", message: { ...message }, assistantMessageEvent: { type: "text_delta", delta: "x" } });
    tracker.observe({ type: "message_end", message });
    const records = tracker.drain([{ ...assistant("a1"), message }]);
    assert.equal(records.length, 1);
    assert.equal(records[0].status, "excluded");
    assert.equal(records[0].exclusionReason, item.reason);
    assert.equal(records[0].outputDeltaCount, item.deltas);
  }
});
