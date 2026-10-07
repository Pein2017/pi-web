import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-policy-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
test.after(() => rm(agentDir, { recursive: true, force: true }));
const policy = { model: "policy-child/chosen", thinking: "high", max_turns: 4, inherit_context: false, run_in_background: false, isolation: "off" };
const requestPolicy = p => ({ model: p.model, thinking: p.thinking, maxTurns: p.max_turns, inheritContext: p.inherit_context, runInBackground: p.run_in_background, isolation: p.isolation });
const done = () => fauxAssistantMessage("done");

async function fixture(t) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-policy-cwd-"));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  // Deliberately conflicting legacy execution defaults; none is authoritative.
  const profilePath = join(cwd, ".pi", "agents", "general-purpose.md");
  await writeFile(profilePath, "---\ntools: read\nmodel: nonexistent/legacy\nthinking: off\nmax_turns: 1\ninherit_context: true\nrun_in_background: true\nisolation: worktree\n---\nResource bundle marker.\n");
  const leadFaux = fauxProvider({ provider: "policy-lead", models: [{ id: "lead" }] });
  const childFaux = fauxProvider({ provider: "policy-child", models: [{ id: "chosen", reasoning: true }, { id: "next", reasoning: true }, { id: "no-thinking", reasoning: false }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(leadFaux.provider); modelRuntime.registerNativeProvider(childFaux.provider);
  const wrappers = new Map();
  let reopened = 0;
  const controller = createSubagentController({
    getSession: id => wrappers.get(id),
    registerSession: inner => { wrappers.set(inner.sessionId, wrap(inner)); void inner.bindExtensions({}); },
    reopenSession: async () => { reopened++; throw new Error("must not reopen rejected child"); },
    resolveSessionPath: async id => wrappers.get(id)?.sessionFile ?? null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  function wrap(inner) { return { inner, cwd, sessionFile: inner.sessionFile, isAlive: () => true, isRunning: () => inner.isStreaming, waitUntilReady: async () => {} }; }
  const services = await createAgentSessionServices({ cwd, agentDir, modelRuntime, settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { noSkills: true, noExtensions: true, noContextFiles: true, extensionFactories: [createSubagentExtension(controller.extensionRuntime, () => [{ name: "general-purpose", enabled: true, tools: ["read"], model: "nonexistent/legacy", description: "Resources" }])] } });
  const { session: lead } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(cwd), model: leadFaux.getModel("lead") });
  wrappers.set(lead.sessionId, wrap(lead)); await lead.bindExtensions({});
  t.after(async () => { for (const { inner } of wrappers.values()) { await inner.extensionRunner?.emit({ type: "session_shutdown" }); inner.dispose(); } await rm(cwd, { recursive: true, force: true }); });
  async function call(args) {
    leadFaux.setResponses([context => {
      const schema = getCurrentTools(context.messages).find(tool => tool.name === "Agent");
      assert.ok(schema);
      assert.doesNotMatch(schema.description, /nonexistent\/legacy/, "profile model must not advertise execution defaults");
      return fauxAssistantMessage([fauxToolCall("Agent", { prompt: "Inspect", description: "Policy", ...args })], { stopReason: "toolUse" });
    }, done]);
    await lead.prompt("Delegate without PRIVATE_PARENT_HISTORY_MARKER");
    return lead.messages.filter(m => m.role === "toolResult" && m.toolName === "Agent").at(-1);
  }
  const request = { parentContext: lead, parentToolCallId: "direct", profile: "general-purpose", task: "Inspect", description: "Policy", ...requestPolicy(policy) };
  return { cwd, profilePath, wrappers, controller, childFaux, lead, call, request, reopened: () => reopened };
}

test("native lead Agent caller rejects every missing decision without launching a child", async t => {
  const f = await fixture(t);
  for (const field of Object.keys(policy)) {
    const args = { ...policy }; delete args[field];
    const result = await f.call(args);
    assert.equal(result.isError, true, field);
    assert.equal(f.wrappers.size, 1, `${field} must not launch`);
  }
  const tools = new Map();
  await createSubagentExtension(f.controller.extensionRuntime, () => []).factory({ registerTool: tool => tools.set(tool.name, tool) });
  const schema = tools.get("Agent").parameters;
  for (const field of Object.keys(policy)) assert.ok(schema.required.includes(field), field);
  assert.deepEqual(schema.properties.isolation.anyOf.map(v => v.const), ["off", "worktree"]);
});

test("native Agent caller rejects coerced strings/numbers instead of treating them as decisions", async t => {
  const f = await fixture(t);
  f.childFaux.setResponses(Array.from({ length: 12 }, done));
  for (const [field, values] of Object.entries({ inherit_context: ["false", 0], run_in_background: ["false", 0], max_turns: ["4", 1.5], model: ["policy-child/no-thinking", "policy-child/missing"] })) {
    for (const value of values) {
      const result = await f.call({ ...policy, [field]: value });
      assert.equal(result.isError, true, `${field}/${value}`);
      assert.equal(f.wrappers.size, 1, "raw invalid decision must not launch");
    }
  }
});

test("runtime rejects missing or malformed decisions before looking up any parent", async () => {
  const controller = createSubagentController({ getSession: () => { throw new Error("parent accessed"); }, registerSession() {}, reopenSession() {}, resolveSessionPath() {}, invalidateSessionList() {}, isBuiltInSubagentsEnabled: () => true });
  const valid = requestPolicy(policy);
  for (const method of ["start", "resume"]) {
    for (const field of Object.keys(valid)) { const request = { ...valid }; delete request[field]; await assert.rejects(controller.extensionRuntime[method](request), /required|must be|Invalid/, `${method}/${field}`); }
    for (const [field, values] of Object.entries({ model: ["chosen", "p/", " /m"], thinking: ["", "auto"], maxTurns: [0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, "3"], inheritContext: [0, "false"], runInBackground: [1, "false"], isolation: ["", "none", true] })) {
      for (const value of values) await assert.rejects(controller.extensionRuntime[method]({ ...valid, [field]: value }), /required|must be|Invalid/, `${method}/${field}/${value}`);
    }
  }
});

test("native consumer receives explicit choices, false/off beat profile defaults; resume setters and N/N+1 budget work", async t => {
  const f = await fixture(t);
  const consumed = [];
  f.childFaux.setResponses([(context, options, _state, model) => { consumed.push({ context, options, model }); return done(); }]);
  const result = await f.call(policy);
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.deepEqual(result.details.telemetry, { turnCount: 1, turnCountBasis: "turn_end", terminationReason: "completed" }, "legacy max_turns: 1 must not override the explicit budget");
  const child = [...f.wrappers.values()].find(w => w.inner !== f.lead).inner;
  assert.equal(child.model.id, "chosen"); assert.equal(child.thinkingLevel, "high");
  assert.equal(consumed[0].model.id, "chosen"); assert.equal(consumed[0].options.reasoning, "high");
  assert.doesNotMatch(JSON.stringify(consumed[0].context), /PRIVATE_PARENT_HISTORY_MARKER/);
  const meta = child.sessionManager.getEntries().find(e => e.customType === "pi-web:subagent").data;
  assert.equal(meta.runInBackground, false); assert.equal(meta.worktreePath, undefined);
  const snapshot = structuredClone(meta.resourceSnapshot);
  await writeFile(f.profilePath, "---\ntools: bash\nskills: true\n---\nChanged bundle.\n");
  const setters = [];
  const setModel = child.setModel.bind(child), setThinking = child.setThinkingLevel.bind(child);
  child.setModel = async model => { setters.push(["model", model.id]); await setModel(model); };
  child.setThinkingLevel = level => { setters.push(["thinking", level]); setThinking(level); };
  f.childFaux.setResponses([(_context, options, _state, model) => { assert.equal(model.id, "next"); assert.equal(options.reasoning, "low"); return done(); }, done]);
  const resumed = await f.controller.extensionRuntime.resume({ ...f.request, sessionId: child.sessionId, model: "policy-child/next", thinking: "low", maxTurns: 1, runInBackground: true });
  assert.equal(resumed.run.runInBackground, true);
  const terminal = await resumed.completion;
  assert.equal(terminal.status, "completed");
  assert.deepEqual(terminal.telemetry, { turnCount: 2, turnCountBasis: "turn_end", terminationReason: "max-turns" });
  assert.deepEqual(setters[0], ["model", "next"]); assert.ok(setters.some(([key, level]) => key === "thinking" && level === "low"));
  assert.ok(child.messages.some(m => m.role === "user" && JSON.stringify(m.content).includes("reached your turn limit")));
  assert.deepEqual(meta.resourceSnapshot, snapshot); assert.deepEqual(child.getActiveToolNames(), ["read"]);
  // Resume through the native lead caller too, including switching background back off.
  f.lead.sessionManager.appendMessage({ role: "user", content: "NEW_PRIVATE_PARENT_HISTORY_MARKER", timestamp: Date.now() });
  f.childFaux.setResponses([(context, options, _state, model) => {
    assert.equal(model.id, "chosen"); assert.equal(options.reasoning, "medium");
    assert.ok(context.messages.some(m => m.role === "assistant" && JSON.stringify(m.content).includes("done")), "resume retains child history");
    assert.doesNotMatch(JSON.stringify(context), /NEW_PRIVATE_PARENT_HISTORY_MARKER|Changed bundle/);
    return done();
  }]);
  const nativeResume = await f.call({ ...policy, resume: child.sessionId, thinking: "medium" });
  assert.equal(nativeResume.isError, false, JSON.stringify(nativeResume));
  assert.equal(nativeResume.details.runInBackground, false);
  assert.deepEqual(nativeResume.details.telemetry, { turnCount: 1, turnCountBasis: "turn_end", terminationReason: "completed" });
  assert.deepEqual(meta.resourceSnapshot, snapshot);
});

test("explicit inheritance reaches the provider even when the profile replaces the system prompt", async t => {
  const f = await fixture(t);
  await writeFile(f.profilePath, "---\ntools: read\nprompt_mode: replace\n---\nExact bundle prompt.\n");
  f.lead.sessionManager.appendMessage({ role: "user", content: "EXPLICIT_PARENT_CONTEXT_MARKER", timestamp: Date.now() });
  let consumerContext;
  f.childFaux.setResponses([context => { consumerContext = context; return done(); }]);
  const result = await (await f.controller.extensionRuntime.start({ ...f.request, inheritContext: true })).completion;
  assert.equal(result.status, "completed", result.error);
  assert.match(JSON.stringify(consumerContext), /EXPLICIT_PARENT_CONTEXT_MARKER/);
});

test("unsupported/mismatched resumes reject before child setters, journal mutation or reopening", async t => {
  const f = await fixture(t); f.childFaux.setResponses([done]);
  const first = await (await f.controller.extensionRuntime.start(f.request)).completion;
  const child = f.wrappers.get(first.sessionId).inner;
  child.setModel = async () => { throw new Error("setter mutated"); };
  child.setThinkingLevel = () => { throw new Error("setter mutated"); };
  f.wrappers.get(first.sessionId).isAlive = () => false; // validation must also precede reopen
  const unchanged = async (overrides, pattern) => {
    const before = await readFile(child.sessionFile, "utf8");
    await assert.rejects(f.controller.extensionRuntime.resume({ ...f.request, sessionId: child.sessionId, ...overrides }), pattern);
    assert.equal(await readFile(child.sessionFile, "utf8"), before); assert.equal(f.reopened(), 0);
  };
  await unchanged({ inheritContext: true }, /start a new child/i);
  await unchanged({ isolation: "worktree" }, /start a new child/i);
  await unchanged({ model: "policy-child/no-thinking" }, /thinking.*not supported/i);
  await unchanged({ model: "policy-child/missing" }, /model not found/i);
  // An old worktree child retains its mode in metadata even after cleanup.
  const oldJournal = (await readFile(child.sessionFile, "utf8")).trim().split("\n").map(line => JSON.parse(line));
  Object.assign(oldJournal.find(e => e.customType === "pi-web:subagent").data, { worktreePath: join(f.cwd, "removed-worktree"), worktreeBranch: "old" });
  await writeFile(child.sessionFile, oldJournal.map(e => JSON.stringify(e)).join("\n") + "\n");
  child.sessionManager.setSessionFile(child.sessionFile);
  await unchanged({ isolation: "off" }, /start a new child/i);
  await unchanged({ isolation: "worktree" }, /worktree.*start a new child/i);
});
