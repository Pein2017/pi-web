import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { Type } from "@earendil-works/pi-ai";
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { computeObservedDecodeTps, OBSERVED_DECODE_TPS_ENTRY_TYPE } = await jiti.import("./session-decode-tps.ts");
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function prompt(wrapper, message) {
  let dispose;
  const done = new Promise(resolve => {
    dispose = wrapper.onEvent(event => { if (event.type === "prompt_done") resolve(); });
  });
  try {
    await wrapper.send({ type: "prompt", message });
    await done;
  } finally { dispose(); }
}

async function respond(res, id, outputTokens, { tool = false, delay = 30 } = {}) {
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = data => res.write(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  const item = tool
    ? { type: "function_call", id: `fc-${id}`, call_id: `call-${id}`, name: "local_gap", arguments: "{}", status: "completed" }
    : { type: "message", id: `msg-${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: `first ${id}`, annotations: [] }] };
  emit({ type: "response.output_item.added", output_index: 0, item: tool ? { ...item, arguments: "" } : { ...item, content: [] } });
  emit(tool
    ? { type: "response.function_call_arguments.delta", output_index: 0, delta: "{" }
    : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "first " });
  await pause(delay);
  if (res.destroyed) return;
  emit(tool
    ? { type: "response.function_call_arguments.delta", output_index: 0, delta: "}" }
    : { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: id });
  emit({ type: "response.output_item.done", output_index: 0, item });
  emit({ type: "response.completed", response: { id: `response-${id}`, object: "response", status: "completed", output: [item], usage: { input_tokens: 20, output_tokens: outputTokens, input_tokens_details: { cached_tokens: 0 } } } });
  res.end();
}

async function fixture(t, handle, { retry = false, tools = [] } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-decode-tps-sdk-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const requests = [];
  const server = createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      requests.push(JSON.parse(Buffer.concat(chunks).toString()));
      assert.ok(requests.length <= 6, "bounded loopback calls");
      await handle(res, requests.length);
    } catch (error) { res.destroy(error); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const wrappers = [];
  t.after(async () => {
    for (const wrapper of wrappers) wrapper.destroy();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await rm(root, { recursive: true, force: true });
  });
  const runtime = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider("tps-loop", { api: "openai-responses", baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "sk-local-only", models: [{ id: "test", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 128 }] });
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: retry, maxRetries: 1, baseDelayMs: 1, provider: { maxRetries: 0 } }, cacheWarming: "off" }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
  });
  async function open(manager = SessionManager.create(root, sessionDir)) {
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model: runtime.getModel("tps-loop", "test"), tools: tools.map(tool => tool.name), customTools: tools, thinkingLevel: "off" });
    const observations = [];
    const boundsByEvent = new WeakMap();
    let active;
    const now = () => Number(process.hrtime.bigint()) / 1_000_000;
    session.subscribe(event => {
      if (event.type === "message_start" && event.message.role === "assistant") active = { deltas: [] };
      if (event.type === "message_update" && ["text_delta", "thinking_delta", "toolcall_delta"].includes(event.assistantMessageEvent.type) && event.assistantMessageEvent.delta) {
        const bounds = { before: now() };
        boundsByEvent.set(event, bounds);
        active.deltas.push(bounds);
      }
      if (event.type === "message_end" && event.message.role === "assistant") {
        observations.push({ ...active, message: event.message });
        active = undefined;
      }
    });
    const wrapper = new AgentSessionWrapper(session);
    wrappers.push(wrapper);
    wrapper.start();
    session.subscribe(event => { const bounds = boundsByEvent.get(event); if (bounds) bounds.after = now(); });
    return { session, wrapper, manager, observations };
  }
  const records = manager => manager.getEntries().filter(entry => entry.type === "custom" && entry.customType === OBSERVED_DECODE_TPS_ENTRY_TYPE).map(entry => entry.data);
  const reopen = manager => SessionManager.open(manager.getSessionFile(), sessionDir);
  return { open, records, reopen, requests };
}

test("installed SDK copied events persist separate response intervals and reopen/continue through a tool cycle", { timeout: 10000 }, async t => {
  let toolElapsedMs;
  const f = await fixture(t, (res, call) => respond(res, String(call), [100, 30, 300][call - 1], { tool: call === 2 }), {
    tools: [{ name: "local_gap", label: "Local gap", description: "Wait locally.", parameters: Type.Object({}), async execute() {
      const start = performance.now();
      await pause(200);
      toolElapsedMs = performance.now() - start;
      return { content: [{ type: "text", text: "Local tool finished." }], details: undefined };
    } }],
  });
  const first = await f.open();
  const deltaObjects = [];
  let startObject; let finalObject;
  first.session.subscribe(event => {
    if (event.type === "message_start" && event.message.role === "assistant") startObject = event.message;
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") deltaObjects.push(event.message);
    if (event.type === "message_end" && event.message.role === "assistant") finalObject = event.message;
  });
  await prompt(first.wrapper, "First local response.");
  assert.equal(deltaObjects.length, 2);
  assert.notEqual(startObject, deltaObjects[0]);
  assert.notEqual(deltaObjects[0], deltaObjects[1]);
  assert.notEqual(deltaObjects[1], finalObject);
  const initial = computeObservedDecodeTps(first.manager.getEntries());
  assert.equal(initial.measuredResponses, 1, "actual SDK copied objects must retain both deltas");
  assert.equal(initial.outputTokens, 100);
  first.wrapper.destroy();
  const reopened = f.reopen(first.manager);
  assert.deepEqual(computeObservedDecodeTps(reopened.getEntries()), initial);
  assert.ok(!JSON.stringify(reopened.buildSessionContext()).includes(OBSERVED_DECODE_TPS_ENTRY_TYPE));
  const second = await f.open(reopened);
  await prompt(second.wrapper, "Use the local tool then respond.");
  assert.equal(f.requests.length, 3);
  const records = f.records(second.manager);
  assert.deepEqual(records.map(record => [record.status, record.outputTokens, record.outputDeltaCount]), [["measured", 100, 2], ["measured", 30, 2], ["measured", 300, 2]]);
  assert.equal(new Set(records.map(record => record.assistantEntryId)).size, 3);
  assert.ok(records.every(record => record.elapsedMs > 0));
  const summary = computeObservedDecodeTps(second.manager.getEntries());
  assert.equal(summary.outputTokens, 430);
  assert.equal(summary.measuredResponses, 3);
  assert.equal(summary.trackedResponses, 3);
  assert.equal(summary.elapsedMs, records.reduce((sum, record) => sum + record.elapsedMs, 0));
  assert.equal(summary.tps, 430 / (summary.elapsedMs / 1000));
  const observations = [...first.observations, ...second.observations];
  for (const [index, record] of records.entries()) {
    const deltas = observations[index].deltas;
    const firstDelta = deltas[0]; const lastDelta = deltas.at(-1);
    assert.ok(record.elapsedMs >= lastDelta.before - firstDelta.after);
    assert.ok(record.elapsedMs <= lastDelta.after - firstDelta.before, "persisted interval is bounded by actual first/last delta callbacks");
  }
  const toolResponse = second.observations[0]; const finalResponse = second.observations[1];
  assert.ok(finalResponse.deltas[0].before - toolResponse.deltas.at(-1).after >= toolElapsedMs, "real tool gap lies between, outside both response intervals");
  assert.deepEqual(computeObservedDecodeTps(f.reopen(second.manager).getEntries()), summary);
  assert.ok(f.requests.every(request => !JSON.stringify(request).includes(OBSERVED_DECODE_TPS_ENTRY_TYPE)));
});

test("installed SDK abort excludes streamed attempt and a later prompt gets fresh timing", { timeout: 10000 }, async t => {
  const f = await fixture(t, (res, call) => respond(res, String(call), call === 1 ? 7 : 70));
  const { session, wrapper, manager } = await f.open();
  let aborted = false;
  session.subscribe(event => {
    if (!aborted && event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      aborted = true;
      void session.abort();
    }
  });
  await prompt(wrapper, "Abort local stream.");
  await prompt(wrapper, "Fresh local stream.");
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.records(manager).map(record => [record.status, record.exclusionReason, record.outputDeltaCount]), [["excluded", "interrupted", 1], ["measured", undefined, 2]]);
  const summary = computeObservedDecodeTps(f.reopen(manager).getEntries());
  assert.equal(summary.outputTokens, 70);
  assert.equal(summary.measuredResponses, 1);
  assert.equal(summary.trackedResponses, 2);
});

test("installed SDK automatic retry keeps failed nonstreamed attempt separate from measured success", { timeout: 10000 }, async t => {
  const f = await fixture(t, (res, call) => {
    if (call === 1) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end('{"error":{"message":"rate limit local fixture"}}');
      return;
    }
    return respond(res, "retry-success", 150);
  }, { retry: true });
  const { session, wrapper, manager } = await f.open();
  const retryEvents = [];
  session.subscribe(event => { if (event.type === "auto_retry_start") retryEvents.push(event); });
  await prompt(wrapper, "Retry local fixture.");
  assert.equal(f.requests.length, 2);
  assert.equal(retryEvents.length, 1);
  assert.deepEqual(f.records(manager).map(record => [record.status, record.exclusionReason, record.outputDeltaCount]), [["excluded", "interrupted", 0], ["measured", undefined, 2]]);
  const summary = computeObservedDecodeTps(f.reopen(manager).getEntries());
  assert.equal(summary.outputTokens, 150);
  assert.equal(summary.measuredResponses, 1);
  assert.equal(summary.trackedResponses, 2);
});

test("installed SDK final-only response has provider usage but no invented timing", { timeout: 10000 }, async t => {
  const f = await fixture(t, res => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const data = { type: "response.completed", response: { id: "final-only", object: "response", status: "completed", output: [], usage: { input_tokens: 20, output_tokens: 80 } } };
    res.end(`event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`);
  });
  const { wrapper, manager } = await f.open();
  await prompt(wrapper, "Final-only local fixture.");
  assert.equal(f.requests.length, 1);
  const assistant = manager.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant");
  assert.equal(assistant.message.usage.output, 80);
  assert.deepEqual(f.records(manager).map(record => [record.status, record.exclusionReason, record.outputDeltaCount]), [["excluded", "not-streamed", 0]]);
  const summary = computeObservedDecodeTps(f.reopen(manager).getEntries());
  assert.equal(summary.tps, null);
  assert.equal(summary.measuredResponses, 0);
  assert.equal(summary.trackedResponses, 1);
});
