import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const agentDir = await mkdtemp(join(tmpdir(), "pi-child-resources-agent-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const FIXTURE = fileURLToPath(new URL("./__fixtures__/mcp-env-server.mjs", import.meta.url));
test.after(() => rm(agentDir, { recursive: true, force: true }));

async function fixture(t, frontmatter) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-child-resources-cwd-"));
  await mkdir(join(cwd, ".pi", "agents"), { recursive: true });
  await writeFile(join(cwd, ".pi", "agents", "selected.md"), `---\n${frontmatter}\n---\nFocused child.\n`);
  const faux = fauxProvider({ models: [{ id: "resource-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const parent = {
    cwd, sessionFile: join(cwd, "parent.jsonl"), isAlive: () => true, isRunning: () => false,
    inner: { modelRuntime, model: faux.getModel("resource-test"), agent: { state: { thinkingLevel: "off" } } },
  };
  let child;
  const controller = createSubagentController({
    getSession: () => parent,
    registerSession: (inner) => { child = inner; void inner.bindExtensions({}); },
    reopenSession: async () => { throw new Error("unused"); },
    resolveSessionPath: async () => null,
    invalidateSessionList: () => {}, isBuiltInSubagentsEnabled: () => true,
  });
  t.after(async () => {
    if (child) { await child.extensionRunner?.emit({ type: "session_shutdown" }); child.dispose(); }
    await rm(cwd, { recursive: true, force: true });
  });
  return { cwd, faux, modelRuntime, child: () => child, start: async () => {
    const execution = await controller.extensionRuntime.start({ parentContext: { sessionManager: { getSessionId: () => "parent" } }, parentToolCallId: "call", profile: "selected", task: "Inspect", description: "Resource test", model: `${faux.getModel().provider}/resource-test`, thinking: "off", maxTurns: 8, inheritContext: false, runInBackground: false, isolation: "off" });
    const result = await execution.completion;
    assert.equal(result.status, "completed", result.error);
    return result;
  } };
}

async function skill(name) {
  const dir = join(agentDir, "skills", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${name} unique routing description\n---\nFull ${name} instructions, not eagerly injected.\n`);
}

test("real child loader and provider see only selected skill routing, not unrelated context", async (t) => {
  await skill("chosen-skill"); await skill("unrelated-skill");
  await writeFile(join(agentDir, "AGENTS.md"), "PRIVATE_PARENT_CONTEXT_MARKER");
  const f = await fixture(t, "tools: read\nskills: [chosen-skill]\nload_extensions: false");
  let context;
  f.faux.setResponses([(input) => { context = input; return fauxAssistantMessage([fauxText("done")]); }]);
  await f.start();
  assert.deepEqual(f.child().resourceLoader.getSkills().skills.map(s => s.name), ["chosen-skill"]);
  assert.match(JSON.stringify(context), /chosen-skill unique routing description/);
  assert.doesNotMatch(JSON.stringify(context), /unrelated-skill|PRIVATE_PARENT_CONTEXT_MARKER|Full chosen-skill instructions/);
});

test("real child loads only explicit extension file and MCP server/tool, including reopen", async (t) => {
  const f = await fixture(t, "tools: read\nload_skills: false\nextensions: [./.pi/extensions/selected.ts]\nmcp_servers: [selected-server]\nmcp_tools: [selected-server/env_has]");
  await mkdir(join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(agentDir, "trust.json"), JSON.stringify({ [f.cwd]: true }));
  await writeFile(join(f.cwd, ".pi", "extensions", "selected.ts"), "export default function(pi) { pi.registerCommand('selected_marker', {description: 'selected', handler: async () => {}}); }");
  await mkdir(join(agentDir, "extensions"), { recursive: true });
  await writeFile(join(agentDir, "extensions", "unrelated.ts"), "export default function(pi) { pi.registerCommand('unrelated_marker', {description: 'unrelated', handler: async () => {}}); }");
  const excludedStart = join(f.cwd, "excluded-started");
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    "selected-server": { command: process.execPath, args: [FIXTURE], exposure: "direct" },
    "excluded-server": { command: process.execPath, args: [FIXTURE], env: { PI_WEB_FIXTURE_PID_FILE: excludedStart } },
  } }));
  const declarations = [];
  const consumerContexts = [];
  f.faux.setResponses([
    context => { consumerContexts.push(context); declarations.push(getCurrentTools(context.messages).map(t => t.name)); return fauxAssistantMessage([fauxToolCall("tool_search", { query: "env_has", limit: 8 })], { stopReason: "toolUse" }); },
    context => { declarations.push(getCurrentTools(context.messages).map(t => t.name)); return fauxAssistantMessage([fauxToolCall("mcp__selected_server__env_has", { name: "PATH" })], { stopReason: "toolUse" }); },
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  const run = await f.start();
  const child = f.child();
  const nativeCaller = JSON.stringify({ cwd: f.cwd, harness: "pi", session_id: run.sessionId, actor: "pi" });
  const encodedCaller = JSON.stringify(nativeCaller).slice(1, -1);
  assert.ok(JSON.stringify(consumerContexts[0]).includes(encodedCaller), "consumer must receive its actual child identity, not parent environment identity");
  assert.notEqual(run.sessionId, process.env.PI_SESSION_ID);
  const snapshot = child.sessionManager.getEntries().find(e => e.customType === "pi-web:subagent").data.resourceSnapshot;
  assert.equal(snapshot.appendSystemPrompt.join("\n").split("Native Pi Web child caller_context:").length - 1, 1, "identity is frozen once, not a moving per-turn message");
  assert.deepEqual(child.extensionRunner.getRegisteredCommands().filter(c => c.name.endsWith("_marker")).map(c => c.name), ["selected_marker"]);
  assert.ok(declarations[0].includes("tool_search"));
  assert.ok(!declarations[0].some(n => n.startsWith("mcp__")), "MCP is deferred, not eagerly declared");
  assert.ok(declarations[1].includes("mcp__selected_server__env_has"));
  assert.ok(!declarations[1].includes("mcp__selected_server__env_get"));
  assert.ok(!child.getActiveToolNames().includes("bash"));
  for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) assert.ok(!child.getActiveToolNames().includes(name), name);
  assert.ok(child.messages.some(m => m.role === "toolResult" && m.toolName === "mcp__selected_server__env_has" && !m.isError));
  const { existsSync } = await import("node:fs");
  assert.equal(existsSync(excludedStart), false, "unselected server must never start");
  await child.extensionRunner.emit({ type: "session_shutdown" }); child.dispose();
  // Editing the profile cannot widen the persisted child resource scope.
  await writeFile(join(f.cwd, ".pi", "agents", "selected.md"), "---\nskills: true\nextensions: true\nmcp_servers: [excluded-server]\n---\nChanged profile\n");
  const reopened = await startRpcSession(run.sessionId, run.sessionPath);
  t.after(() => reopened.session.destroy());
  await reopened.session.waitUntilReady();
  assert.deepEqual(reopened.session.inner.resourceLoader.getSkills().skills, []);
  assert.deepEqual(reopened.session.inner.extensionRunner.getRegisteredCommands().filter(c => c.name.endsWith("_marker")).map(c => c.name), ["selected_marker"]);
  f.faux.setResponses([context => { consumerContexts.push(context); return fauxAssistantMessage([fauxToolCall("tool_search", { query: "env_has" })], { stopReason: "toolUse" }); }, () => fauxAssistantMessage([fauxText("resumed")])]);
  // Reopened runtime is separate; register the same mocked provider, never an API call.
  reopened.session.inner.modelRuntime.registerNativeProvider(f.faux.provider);
  await reopened.session.inner.setModel(f.faux.getModel("resource-test"));
  await reopened.session.inner.prompt("Continue", { source: "rpc" });
  assert.ok(JSON.stringify(consumerContexts.at(-1)).includes(encodedCaller), "reopen retains caller identity with its resource snapshot");
  assert.equal(existsSync(excludedStart), false);
  assert.ok(!reopened.session.inner.getActiveToolNames().includes("mcp__selected_server__env_get"));
  for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) assert.ok(!reopened.session.inner.getActiveToolNames().includes(name), name);
});

test("master switches override skill and extension selections in the actual SDK loader", async t => {
  const f = await fixture(t, "tools: read\nload_skills: false\nskills: [chosen-skill]\nload_extensions: false\nextensions: [./.pi/extensions/selected.ts]");
  await skill("chosen-skill");
  await mkdir(join(f.cwd, ".pi", "extensions"), { recursive: true });
  await writeFile(join(f.cwd, ".pi", "extensions", "selected.ts"), "export default function(pi) { pi.registerCommand('disabled_marker', { description: 'must not load', handler: async () => {} }); }");
  f.faux.setResponses([context => {
    assert.doesNotMatch(JSON.stringify(context), /chosen-skill unique routing description/);
    return fauxAssistantMessage([fauxText("done")]);
  }]);
  await f.start();
  assert.deepEqual(f.child().resourceLoader.getSkills().skills, []);
  assert.deepEqual(f.child().resourceLoader.getExtensions().extensions, []);
});

test("configured MCP works with load_extensions false, while an old resource-free profile stays empty", async (t) => {
  const f = await fixture(t, "tools: read\nload_skills: false\nload_extensions: false\nprompt_mode: replace\nmcp_servers: [selected-server]\nmcp_tools: [selected-server/env_has]");
  await writeFile(join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    "selected-server": { command: process.execPath, args: [FIXTURE], exposure: "direct" },
  } }));
  let consumerContext;
  f.faux.setResponses([
    context => { consumerContext = context; return fauxAssistantMessage([fauxToolCall("tool_search", { query: "env_has" })], { stopReason: "toolUse" }); },
    () => fauxAssistantMessage([fauxToolCall("mcp__selected_server__env_has", { name: "PATH" })], { stopReason: "toolUse" }),
    () => fauxAssistantMessage([fauxText("done")]),
  ]);
  const run = await f.start();
  const encodedCaller = JSON.stringify(JSON.stringify({ cwd: f.cwd, harness: "pi", session_id: run.sessionId, actor: "pi" })).slice(1, -1);
  assert.ok(JSON.stringify(consumerContext).includes(encodedCaller), "replace prompt also carries native child identity");
  assert.ok(f.child().messages.some(m => m.role === "toolResult" && m.toolName === "mcp__selected_server__env_has" && !m.isError));
  assert.deepEqual(f.child().extensionRunner.getRegisteredCommands(), []);
  assert.deepEqual(f.child().resourceLoader.getSkills().skills, []);
  const old = await fixture(t, "tools: read");
  old.faux.setResponses([() => fauxAssistantMessage([fauxText("done")])]);
  await old.start();
  assert.deepEqual(old.child().getActiveToolNames(), ["read"]);
  assert.deepEqual(old.child().resourceLoader.getSkills().skills, []);
  assert.deepEqual(old.child().resourceLoader.getExtensions().extensions, []);
});
