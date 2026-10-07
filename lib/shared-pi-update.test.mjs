import assert from "node:assert/strict";
import test from "node:test";
import { createSharedPiUpdate, startSharedPiUpdateObserver } from "./shared-pi-update.cjs";

function fixture(overrides = {}) {
  const events = [];
  const coordinator = createSharedPiUpdate({
    loadedVersion: "1.0.3", readSelectedVersion: () => "1.0.4",
    hasBusyWork: () => false,
    validate: () => events.push("validate"),
    shutdownIdleSessions: async () => { events.push("shutdown"); },
    activate: () => events.push("activate"), requestRestart: () => events.push("restart"),
    log: () => {}, ...overrides,
  });
  return { events, coordinator };
}

test("unchanged selection and busy work do not dispose or bind SDK", async () => {
  const unchanged = fixture({ readSelectedVersion: () => "1.0.3" });
  await unchanged.coordinator.tick();
  assert.deepEqual(unchanged.events, []);
  let busy = true;
  const { events, coordinator } = fixture({ hasBusyWork: () => busy });
  await coordinator.tick();
  assert.deepEqual(events, []);
  coordinator.assertAdmission();
  busy = false;
  await coordinator.tick();
  assert.deepEqual(events, ["validate", "shutdown", "activate", "restart"]);
});

test("admission closes before asynchronous shutdown and duplicate ticks cannot restart twice", async () => {
  let finish;
  const { events, coordinator } = fixture({ shutdownIdleSessions: () => new Promise((resolve) => { finish = resolve; }) });
  const adoption = coordinator.tick();
  assert.throws(() => coordinator.assertAdmission(), /Pi runtime is updating/);
  await coordinator.tick();
  assert.deepEqual(events, ["validate"]);
  finish();
  await adoption;
  await coordinator.tick();
  assert.deepEqual(events, ["validate", "activate", "restart"]);
});

for (const phase of ["validate", "shutdownIdleSessions", "activate"]) {
  test(`${phase} failure retains worker and reopens admission`, async () => {
    const { events, coordinator } = fixture({ [phase]: () => { throw new Error("test failure"); } });
    await coordinator.tick();
    coordinator.assertAdmission();
    assert.equal(events.includes("restart"), false);
    if (phase === "validate") assert.equal(events.includes("shutdown"), false);
    if (phase === "shutdownIdleSessions") assert.equal(events.includes("activate"), false);
  });
}

test("HMR refreshes callbacks while retaining one global observer and admission gate", (t) => {
  const env = { ...process.env };
  const previous = globalThis.__piSharedUpdate;
  const previousSend = process.send;
  const beforeListeners = new Set(process.listeners("exit"));
  let timers = 0;
  t.mock.method(globalThis, "setInterval", () => { timers += 1; return { unref() {} }; });
  t.after(() => {
    process.env = env;
    process.send = previousSend;
    globalThis.__piSharedUpdate = previous;
    for (const listener of process.listeners("exit")) if (!beforeListeners.has(listener)) process.removeListener("exit", listener);
  });
  globalThis.__piSharedUpdate = undefined;
  process.env.PI_WEB_FOLLOW_MANAGED_PI = "1";
  process.env.NEXT_PRIVATE_WORKER = "1";
  process.env.PI_MANAGED_INSTALL_ROOT = "/test-owned/not-read-until-tick";
  process.send = () => {};
  startSharedPiUpdateObserver({ hasBusyWork: () => false, shutdownIdleSessions: async () => {} });
  const observer = globalThis.__piSharedUpdate;
  startSharedPiUpdateObserver({ hasBusyWork: () => true, shutdownIdleSessions: async () => {} });
  assert.equal(globalThis.__piSharedUpdate, observer);
  assert.equal(timers, 1);
});
