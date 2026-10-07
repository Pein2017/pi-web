import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { AgentSessionWrapper, startRpcSession, setRpcSessionTools, hasBusyRpcWorkForRuntimeUpdate } = await jiti.import("./rpc-manager.ts");
const { createTerminal, hasOpenTerminalShells } = await jiti.import("./terminal-manager.ts");

test("adoption blocks session starts, tool changes, commands and terminal creation before side effects", async (t) => {
  const previous = globalThis.__piSharedUpdate;
  globalThis.__piSharedUpdate = { assertAdmission() { throw new Error("Pi runtime is updating; retry shortly"); } };
  t.after(() => { globalThis.__piSharedUpdate = previous; });
  await assert.rejects(startRpcSession("update-test", "", undefined), /Pi runtime is updating/);
  await assert.rejects(setRpcSessionTools("update-test", undefined, []), /Pi runtime is updating/);
  let changed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: "update-test", sessionManager: { getCwd: () => "/tmp" },
    setSessionName() { changed = true; }, dispose() {}, extensionRunner: {},
  });
  t.after(() => wrapper.destroy());
  await assert.rejects(wrapper.send({ type: "set_session_name", name: "must not persist" }), /Pi runtime is updating/);
  assert.equal(changed, false);
  assert.throws(() => createTerminal("/this-update-test-path-does-not-exist-9183", 80, 24), /Pi runtime is updating/);
});

test("idle predicate retains prompt preflight, SDK queue, binding, closing, starts and terminal shells", async (t) => {
  const inner = { sessionId: "busy-test", sessionManager: { getCwd: () => "/tmp" }, extensionRunner: {}, dispose() {} };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  assert.equal(wrapper.isBusyForRuntimeUpdate(), false);
  for (const field of ["activeMutatingCommands", "pendingPromptCount", "extensionBindingPending", "closing"]) {
    wrapper[field] = field === "closing" || field === "extensionBindingPending" ? true : 1;
    assert.equal(wrapper.isBusyForRuntimeUpdate(), true, field);
    wrapper[field] = field === "closing" || field === "extensionBindingPending" ? false : 0;
  }
  for (const field of ["isStreaming", "isCompacting", "isBashRunning", "pendingMessageCount", "isIdle"]) {
    inner[field] = field === "isIdle" ? false : field === "pendingMessageCount" ? 1 : true;
    assert.equal(wrapper.isBusyForRuntimeUpdate(), true, field);
    delete inner[field];
  }
  const previousLocks = globalThis.__piStartLocks;
  const previousRegistry = globalThis.__piSessions;
  const previousTerminals = globalThis.__piWebTerminals;
  const previousSubagents = globalThis.__piSubagentRuns;
  const previousNotifications = globalThis.__piSubagentNotifications;
  t.after(() => {
    globalThis.__piStartLocks = previousLocks;
    globalThis.__piSessions = previousRegistry;
    globalThis.__piWebTerminals = previousTerminals;
    globalThis.__piSubagentRuns = previousSubagents;
    globalThis.__piSubagentNotifications = previousNotifications;
  });
  globalThis.__piSessions = new Map([["busy-test", wrapper]]);
  globalThis.__piStartLocks = new Map([["pending", Promise.resolve()]]);
  assert.equal(hasBusyRpcWorkForRuntimeUpdate(), true);
  globalThis.__piStartLocks.clear();
  assert.equal(hasBusyRpcWorkForRuntimeUpdate(), false);
  globalThis.__piSubagentRuns = new Map([["child", { run: { status: "queued" } }]]);
  assert.equal(hasBusyRpcWorkForRuntimeUpdate(), true);
  globalThis.__piSubagentRuns.clear();
  globalThis.__piSubagentNotifications = 1;
  assert.equal(hasBusyRpcWorkForRuntimeUpdate(), true);
  globalThis.__piSubagentNotifications = 0;
  globalThis.__piWebTerminals = new Map([["shell", { exited: false }]]);
  assert.equal(hasOpenTerminalShells(), true);
  globalThis.__piWebTerminals.get("shell").exited = true;
  assert.equal(hasOpenTerminalShells(), false);
});

test("an admitted command awaiting the SDK keeps adoption busy without a streaming run", async (t) => {
  let finish;
  const inner = {
    sessionId: "setter-test", sessionManager: { getCwd: () => "/tmp" }, extensionRunner: {}, dispose() {},
    modelRuntime: { getModel: () => ({ id: "fixture", provider: "fixture" }) },
    setModel: () => new Promise((resolve) => { finish = resolve; }),
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  const changing = wrapper.send({ type: "set_model", provider: "fixture", modelId: "fixture" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(Boolean(wrapper.isRunning()), false);
  assert.equal(wrapper.isBusyForRuntimeUpdate(), true);
  finish();
  await changing;
  assert.equal(wrapper.isBusyForRuntimeUpdate(), false);
});
