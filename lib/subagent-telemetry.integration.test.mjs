import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-telemetry-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
await mkdir(join(agentDir, "agents"), { recursive: true });
await writeFile(join(agentDir, "agents", "settings.json"), JSON.stringify({ maxConcurrent: 1 }));
const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { readSubagentRun, SUBAGENT_RESULT_TYPE } = await jiti.import("./subagents.ts");
test.after(() => rm(agentDir, { recursive: true, force: true }));
const telemetry = (turnCount, terminationReason) => ({ turnCount, turnCountBasis: "turn_end", terminationReason });

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-telemetry-cwd-"));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "focused.md"), "---\ntools: read\nload_skills: false\nload_extensions: false\n---\nFocused task.\n");
  const faux = fauxProvider({ models: [{ id: "telemetry-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parentId = `parent-${cwd}`;
  const parent = { cwd, sessionFile: join(cwd, "parent.jsonl"), isAlive: () => true, isRunning: () => false,
    inner: { modelRuntime, model: faux.getModel("telemetry-test"), agent: { state: { thinkingLevel: "off" } }, sessionManager: { getSessionId: () => parentId } } };
  const children = new Map();
  const listeners = new Map();
  const controller = createSubagentController({
    getSession: id => id === parentId ? parent : children.get(id),
    registerSession: inner => {
      // Track only the controller's subscription, not SDK internals; inject event mismatches when needed.
      const active = new Set();
      const subscribe = inner.subscribe.bind(inner);
      inner.subscribe = listener => { active.add(listener); const off = subscribe(listener); return () => { active.delete(listener); off(); }; };
      listeners.set(inner.sessionId, active);
      children.set(inner.sessionId, { inner, cwd, sessionFile: inner.sessionFile, isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} });
      void inner.bindExtensions({});
    },
    reopenSession: async id => children.get(id), resolveSessionPath: async id => children.get(id)?.sessionFile ?? null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  t.after(async () => { for (const { inner } of children.values()) { await inner.extensionRunner?.emit({ type: "session_shutdown" }); inner.dispose(); } await rm(cwd, { recursive: true, force: true }); });
  const request = { parentContext: parent.inner, parentToolCallId: "call", profile: "focused", task: "Inspect", description: "Telemetry", model: `${faux.getModel().provider}/telemetry-test`, thinking: "off", maxTurns: 8, inheritContext: false, runInBackground: false, isolation: "off" };
  return { cwd, faux, controller, children, listeners,
    start: options => controller.extensionRuntime.start({ ...request, ...options }),
    resume: (id, options) => controller.extensionRuntime.resume({ ...request, sessionId: id, ...options }),
  };
}

async function assertResult(f, execution, expected, status = "completed") {
  const result = await execution.completion;
  assert.equal(result.status, status, result.error);
  assert.deepEqual(result.telemetry, expected);
  const inner = f.children.get(result.sessionId).inner;
  const entries = inner.sessionManager.getEntries();
  assert.deepEqual(entries.filter(e => e.customType === SUBAGENT_RESULT_TYPE).at(-1).data.telemetry, expected);
  assert.deepEqual((await f.controller.get(result.sessionId)).telemetry, expected);
  assert.deepEqual(readSubagentRun(SessionManager.open(inner.sessionFile).getEntries(), result.sessionId, inner.sessionFile).telemetry, expected);
  assert.equal(f.listeners.get(result.sessionId).size, 0, "terminal invocation must unsubscribe");
  return result;
}

const done = () => fauxAssistantMessage([fauxText("done")]);

test("real SDK counts start/resume turn_end events separately below an explicit budget", async t => {
  const f = await fixture(t);
  f.faux.setResponses([done]);
  const first = await assertResult(f, await f.start(), telemetry(1, "completed"));
  f.faux.setResponses([() => fauxAssistantMessage([fauxToolCall("read", { path: ".pi/agents/focused.md" })], { stopReason: "toolUse" }), done]);
  const resumed = await f.resume(first.sessionId);
  assert.equal(resumed.run.telemetry, undefined, "resume must not inherit the first result's telemetry");
  await assertResult(f, resumed, telemetry(2, "completed"));
  f.faux.setResponses([done]);
  await assertResult(f, await f.resume(first.sessionId), telemetry(1, "completed"));
});

test("counter uses turn_end, not assistant records/message_end", async t => {
  const f = await fixture(t);
  f.faux.setResponses([done]);
  const firstExecution = await f.start();
  const first = await firstExecution.completion;
  const inner = f.children.get(first.sessionId).inner;
  inner.prompt = async () => {
    inner.sessionManager.appendMessage(fauxAssistantMessage([fauxText("extra persisted response")]));
    for (const listener of f.listeners.get(first.sessionId)) {
      for (let n = 0; n < 5; n++) listener({ type: "message_end", message: done() });
      listener({ type: "turn_end" }); listener({ type: "turn_end" });
    }
  };
  await assertResult(f, await f.resume(first.sessionId), telemetry(2, "completed"));
});

test("soft wrap-up and hard max-turn abort preserve completed status but persist max-turns", async t => {
  const f = await fixture(t);
  f.faux.setResponses([done, done]);
  const execution = await f.start({ maxTurns: 1 });
  const inner = f.children.get(execution.run.sessionId).inner;
  await assertResult(f, execution, telemetry(2, "max-turns"));
  assert.ok(inner.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("reached your turn limit")));
});

test("provider and runtime errors keep their actual source on starts and resumes", async t => {
  const f = await fixture(t);
  f.faux.setResponses([() => fauxAssistantMessage([], { stopReason: "error", errorMessage: "provider rejected request" })]);
  const first = await assertResult(f, await f.start(), telemetry(1, "provider-error"), "failed");
  const inner = f.children.get(first.sessionId).inner;
  inner.prompt = async () => { throw new Error("runtime setup failure"); };
  await assertResult(f, await f.resume(first.sessionId), telemetry(0, "runtime-error"), "failed");
});

test("active abort persists observed count and unsubscribes", async t => {
  const f = await fixture(t);
  let entered;
  const ready = new Promise(resolve => { entered = resolve; });
  f.faux.setResponses([async (_context, options) => {
    entered();
    await new Promise(resolve => { options.signal.addEventListener("abort", resolve, { once: true }); });
    return fauxAssistantMessage([], { stopReason: "aborted" });
  }]);
  const execution = await f.start();
  await ready;
  await f.controller.abort(execution.run.sessionId);
  await assertResult(f, execution, telemetry(1, "abort-requested"), "aborted");
});

test("queued start/resume abort persists zero and removes subscriptions and parent abort listeners", async t => {
  const f = await fixture(t);
  f.faux.setResponses([done]);
  const first = await (await f.start()).completion;
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  f.faux.setResponses([async () => { await blocked; return done(); }]);
  const blocker = await f.start();
  for (const kind of ["start", "resume"]) {
    const signal = new AbortController();
    let listeners = 0;
    const add = signal.signal.addEventListener.bind(signal.signal), remove = signal.signal.removeEventListener.bind(signal.signal);
    signal.signal.addEventListener = (...args) => { if (args[0] === "abort") listeners++; return add(...args); };
    signal.signal.removeEventListener = (...args) => { if (args[0] === "abort") listeners--; return remove(...args); };
    const execution = kind === "start" ? await f.start({ signal: signal.signal }) : await f.resume(first.sessionId, { signal: signal.signal });
    assert.equal(execution.run.status, "queued");
    assert.equal(f.listeners.get(execution.run.sessionId).size, 1, "all queued profiles subscribe");
    signal.abort();
    await assertResult(f, execution, telemetry(0, "abort-requested"), "aborted");
    assert.equal(listeners, 0, "queued abort must remove parent signal listener");
  }
  release();
  await blocker.completion;
});

for (const kind of ["start", "resume"]) test(`an already-aborted foreground caller never prompts a ${kind}`, async t => {
  const f = await fixture(t);
  f.faux.setResponses([done]);
  const first = await (await f.start()).completion;
  const signal = new AbortController();
  signal.abort();
  let providerCalls = 0;
  f.faux.setResponses(Array.from({ length: 4 }, () => context => { assert.ok(context.messages); providerCalls++; return done(); }));
  const execution = kind === "start" ? await f.start({ signal: signal.signal }) : await f.resume(first.sessionId, { signal: signal.signal });
  await assertResult(f, execution, telemetry(0, "abort-requested"), "aborted");
  assert.equal(providerCalls, 0, "cancelled caller must not make model requests");
});

test("historical and in-progress results have absent telemetry; invalid telemetry remains unknown", async () => {
  const meta = { type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "p", parentSessionPath: "/p" } };
  const result = value => ({ type: "custom", customType: SUBAGENT_RESULT_TYPE, data: { version: 1, status: "completed", completedAt: "now", ...value } });
  assert.equal(readSubagentRun([meta, result({})], "c", "/c").telemetry, undefined);
  for (const invalid of [telemetry(-1, "completed"), telemetry(1.5, "completed"), telemetry(1, "other"), { ...telemetry(1, "completed"), turnCountBasis: "assistant" }]) {
    assert.equal(readSubagentRun([meta, result({ telemetry: invalid })], "c", "/c").telemetry, undefined);
  }
  assert.deepEqual(readSubagentRun([meta, result({ telemetry: telemetry(0, "completed") })], "c", "/c").telemetry, telemetry(0, "completed"));
  assert.equal(readSubagentRun([meta, result({ telemetry: telemetry(8, "completed") }), { type: "custom", customType: "pi-web:subagent-status", data: { version: 1, status: "queued" } }], "c", "/c").telemetry, undefined);
});
