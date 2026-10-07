// Run explicitly: node --test bin/shared-pi-update.integration.test.mjs
// Starts only a disposable Next project, never this checkout's app or .next.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@earendil-works/pi-coding-agent";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const { RESTART_EXIT_CODE } = require("next/dist/server/lib/utils");
const sdkEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
const nextEntry = require.resolve("next/dist/bin/next");

async function until(check, label, logs) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(50);
  }
  throw new Error(`${label} did not complete within 20s\n${logs()}`);
}

async function getState(url) {
  try {
    const result = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return result.ok ? await result.json() : null;
  } catch { return null; }
}

test("Next dev restart adopts an external SDK binding under the same CLI and preserves Pi history", async (t) => {
  assert.equal(RESTART_EXIT_CODE, 77);
  const scratchParent = join(webRoot, ".local", "qualification");
  await mkdir(scratchParent, { recursive: true });
  const root = await mkdtemp(join(scratchParent, "shared-pi-update-"));
  const project = join(root, "web");
  const profile = join(root, "agent");
  const install = join(profile, "install");
  const pointer = join(install, "current-version");
  let cli;
  let output = "";
  const logs = () => output;
  t.after(async () => {
    if (cli && cli.exitCode === null && cli.signalCode === null) {
      const exited = once(cli, "exit");
      cli.kill("SIGTERM");
      const timer = new AbortController();
      try {
        await Promise.race([exited, delay(8000, undefined, { signal: timer.signal }).then(() => { throw new Error("test-owned Next CLI did not stop"); })]);
      } finally { timer.abort(); }
    }
    await rm(root, { force: true, recursive: true });
  });
  await mkdir(join(project, "node_modules"), { recursive: true });
  await mkdir(join(project, "bin"));
  await mkdir(join(project, "lib"));
  await mkdir(join(project, "app", "probe"), { recursive: true });
  await mkdir(install, { recursive: true });
  for (const name of ["next", "react", "react-dom"]) {
    await symlink(join(webRoot, "node_modules", name), join(project, "node_modules", name), "dir");
  }
  await writeFile(join(project, "package.json"), JSON.stringify({ name: "pi-update-isolated-fixture", private: true, type: "module", dependencies: { next: "16.3.6", react: "19.2.4", "react-dom": "19.2.4" } }));
  await writeFile(join(project, "next.config.mjs"), `export default ${JSON.stringify({ turbopack: { root: resolve(webRoot, "../..") }, outputFileTracingRoot: resolve(webRoot, "../.."), serverExternalPackages: ["@earendil-works/pi-coding-agent"] })};\n`);
  await writeFile(join(project, "app", "layout.js"), "export default function Layout({children}) { return <html><body>{children}</body></html>; }\n");
  await cp(join(webRoot, "bin", "use-shared-pi.cjs"), join(project, "bin", "use-shared-pi.cjs"));
  await cp(join(webRoot, "lib", "shared-pi-update.cjs"), join(project, "lib", "shared-pi-update.cjs"));
  await writeFile(join(project, "instrumentation.js"), `export async function register() {
    if (process.env.NEXT_RUNTIME === "nodejs") {
      const { startSharedPiUpdateObserver } = await import("./lib/shared-pi-update.cjs");
      globalThis.__fixtureBusy = true;
      startSharedPiUpdateObserver({ hasBusyWork: () => globalThis.__fixtureBusy, shutdownIdleSessions: async () => {} });
    }
  }\n`);
  await writeFile(join(install, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
  // Two test-owned release directories delegate persistence to the real SDK.
  // Their generation/path exports distinguish fresh native module consumption;
  // this test does not claim compatibility with an unknown future SDK version.
  const versions = ["1.0.3-fixture-a", "1.0.3-fixture-b"];
  const scopes = [];
  for (const version of versions) {
    const scope = join(install, "releases", version, "node_modules", "@earendil-works");
    scopes.push(scope);
    for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
      const directory = join(scope, name);
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version, type: "module", exports: "./index.js" }));
      await writeFile(join(directory, "index.js"), name === "pi-coding-agent" ? `export { SessionManager } from ${JSON.stringify(sdkEntry)};\nexport const sdkGeneration = ${JSON.stringify(version)};\nexport const sdkPhysicalPath = import.meta.url;\n` : "export {};\n");
    }
  }
  await writeFile(pointer, versions[0]);
  const manager = SessionManager.create(project, join(profile, "sessions"));
  const expected = "TEST_OWNED_PERSISTED_TASK_742";
  manager.appendMessage({ role: "user", content: expected, timestamp: Date.now() });
  // Pi writes a new session only after the first assistant entry.
  manager.appendMessage({ role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", content: [{ type: "text", text: "Persisted without a model request." }], stopReason: "stop", timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  const historyPath = manager.getSessionFile();
  assert.ok(historyPath);
  const historyBefore = await readFile(historyPath, "utf8");
  const env = { ...process.env, PI_CODING_AGENT_DIR: profile, PI_MANAGED_INSTALL_ROOT: install, PI_UPDATE_FIXTURE_HISTORY: historyPath, PI_UPDATE_FIXTURE_PROJECT: project, NEXT_TELEMETRY_DISABLED: "1", NODE_ENV: "development", NODE_OPTIONS: "", CI: "1" };
  env.PI_WEB_FOLLOW_MANAGED_PI = "1";
  delete env.PI_CODING_AGENT_SESSION_DIR;
  delete env.NEXT_TRACE_UPLOAD_URL;
  const activation = spawnSync(process.execPath, [join(project, "bin", "use-shared-pi.cjs"), "--activate"], { cwd: project, env, encoding: "utf8" });
  assert.equal(activation.status, 0, activation.stderr);
  await writeFile(join(project, "app", "probe", "route.js"), `
import { SessionManager, sdkGeneration, sdkPhysicalPath } from "@earendil-works/pi-coding-agent";
export const dynamic = "force-dynamic";
export function GET() {
  const manager = SessionManager.open(process.env.PI_UPDATE_FIXTURE_HISTORY);
  return Response.json({ pid: process.pid, ppid: process.ppid, generation: sdkGeneration, sdkPath: sdkPhysicalPath, sessionId: manager.getSessionId(), history: manager.getBranch().map(entry => entry.type === "message" ? entry.message.content : null) });
}
export function POST() {
  globalThis.__fixtureBusy = false;
  return Response.json({ restarting: true, pid: process.pid });
}
`);
  cli = spawn(process.execPath, [nextEntry, "dev", project, "-H", "127.0.0.1", "-p", "0"], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
  const cliPid = cli.pid;
  for (const stream of [cli.stdout, cli.stderr]) stream.on("data", chunk => { output = (output + chunk.toString()).slice(-16000); });
  cli.on("error", error => { output += `\n${error.message}`; });
  const port = await until(() => output.match(/http:\/\/127\.0\.0\.1:(\d+)/)?.[1], "isolated Next listen", logs);
  const url = `http://127.0.0.1:${port}/probe`;
  const before = await until(() => getState(url), "initial SDK read", logs);
  assert.equal(before.ppid, cliPid);
  assert.equal(before.generation, versions[0]);
  assert.equal(before.sdkPath, new URL(`file://${join(scopes[0], "pi-coding-agent", "index.js")}`).href);
  assert.equal(before.sessionId, manager.getSessionId());
  assert.ok(JSON.stringify(before.history).includes(expected));
  await writeFile(pointer, versions[1]);
  await delay(2200);
  // Negative boundary: changing the selected release alone cannot replace a
  // worker's imported native SDK module or process identity.
  const unchanged = await getState(url);
  assert.equal(unchanged.pid, before.pid);
  assert.equal(unchanged.generation, versions[0]);
  const trigger = await fetch(url, { method: "POST", signal: AbortSignal.timeout(2000) });
  assert.equal(trigger.status, 200);
  const after = await until(async () => { const state = await getState(url); return state?.pid !== before.pid && state?.generation === versions[1] ? state : null; }, "restarted SDK read", logs);
  assert.equal(cli.exitCode, null, "original dev CLI must remain alive");
  assert.equal(after.ppid, cliPid, "new worker must belong to the original CLI");
  assert.notEqual(after.pid, before.pid);
  assert.equal(after.sdkPath, new URL(`file://${join(scopes[1], "pi-coding-agent", "index.js")}`).href);
  assert.equal(after.sessionId, before.sessionId);
  assert.deepEqual(after.history, before.history);
  assert.equal(await readFile(historyPath, "utf8"), historyBefore, "restart must not rewrite persisted task history");
  t.diagnostic(JSON.stringify({ nextVersion: require("next/package.json").version, restartCode: RESTART_EXIT_CODE, cliPid, previousWorkerPid: before.pid, nextWorkerPid: after.pid, previousRelease: before.generation, nextRelease: after.generation, unchangedHistory: true }));
});
