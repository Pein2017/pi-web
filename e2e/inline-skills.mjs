// Task 3.1: real browser composer -> Pi Web API -> installed SDK -> loopback fake provider.
// Run with: node e2e/inline-skills.mjs
// The child process uses a sanitized environment and a private source snapshot. It
// never builds or starts the active checkout's Next.js instance.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const qualificationRoot = join(repoRoot, ".local/qualification/inline-skills");
const browserCache = join(qualificationRoot, "browser-cache");
const workerArg = "--isolated-worker";
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_CALLS = 12;
const MAX_RUNTIME_MS = 12 * 60_000;
const MAIN_MARKER = "INLINE_SMOKE_MAIN_REQUEST";
const STEER_MARKER = "INLINE_SMOKE_STEER_REQUEST";
const FOLLOW_UP_MARKER = "INLINE_SMOKE_FOLLOW_UP_REQUEST";
const NORMAL_MULTI_MARKER = "INLINE_SMOKE_NORMAL_MULTI_REQUEST";
const ALPHA_BODY = "INLINE_SMOKE_ALPHA_BODY_SENTINEL";
const BETA_BODY = "INLINE_SMOKE_BETA_BODY_SENTINEL";
const GAMMA_BODY = "INLINE_SMOKE_GAMMA_BODY_SENTINEL";
const FAUX_REPLY = "INLINE_SKILLS_FAUX_PROVIDER_TERMINAL_OK";
const MODEL_PROVIDER = "inline-smoke-local";
const MODEL_ID = "inline-smoke-model";
const MODEL_API_KEY = "inline-smoke-not-a-credential";
const GOOGLE_FONT_URL = "https://fonts.googleapis.com/css2?family=Noto+Sans+Mono:wght@100..900&display=swap";

let pendingSignal;
let stopActiveSmoke = () => {};

function requestWorkerShutdown(signal) {
  pendingSignal ??= signal;
  process.exitCode = signal === "SIGINT" ? 130 : 143;
  stopActiveSmoke();
}

const RUNTIME_ROOTS = new Set(["app", "bin", "components", "hooks", "lib", "public"]);
const ROOT_FILES = new Set([
  "instrumentation-node.ts",
  "instrumentation.ts",
  "next.config.ts",
  "next-env.d.ts",
  "package.json",
  "postcss.config.mjs",
  "proxy.ts",
  "tailwind.config.ts",
  "tsconfig.json",
]);

function safeWorkerEnvironment() {
  const env = {};
  // Do not inherit provider credentials, proxy agents, preload hooks, profile
  // selectors, or state/cache overrides. The fake provider uses a fixture key.
  for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM", "CI", "USER", "LOGNAME", "SHELL", "SYSTEMROOT", "WINDIR", "COMSPEC"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  return env;
}

function startSanitizedWorker() {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), workerArg], {
    cwd: repoRoot,
    env: safeWorkerEnvironment(),
    stdio: "inherit",
  });
  const exit = once(child, "exit");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => child.kill(signal));
  }
  child.once("error", (error) => {
    console.error(`Unable to start isolated acceptance worker: ${error.message}`);
  });
  void exit.then(([code, signal]) => {
    process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
  });
}

function gitFiles(args) {
  const output = execFileSync("git", ["-C", repoRoot, ...args], { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 });
  return output.toString("utf8").split("\0").filter(Boolean);
}

function isRuntimePath(path) {
  const normalized = path.replaceAll("\\", "/");
  const first = normalized.split("/")[0];
  return RUNTIME_ROOTS.has(first) || ROOT_FILES.has(normalized);
}

function isAllowedTaskUntracked(path) {
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /^(?:lib|components|hooks|app)\/(?:[^/]*\/)*(?:[^/]*(?:skill|mention)[^/]*)(?:\/.*)?$/.test(normalized);
}

function shouldCopyRuntimeFile(path) {
  const normalized = path.replaceAll("\\", "/");
  if (!isRuntimePath(normalized)) return false;
  if (normalized.split("/").some((part) => ["__fixtures__", "__tests__", "node_modules", ".next", ".local"].includes(part))) return false;
  if (/\.(?:test|spec)\.[^.]+$/.test(normalized)) return false;
  if (normalized.endsWith(".tsbuildinfo")) return false;
  return true;
}

function commonAncestor(paths) {
  const segments = paths.map((path) => resolve(path).split(sep));
  const common = [];
  for (let index = 0; index < Math.min(...segments.map((parts) => parts.length)); index++) {
    const component = segments[0][index];
    if (!segments.every((parts) => parts[index] === component)) break;
    common.push(component);
  }
  assert.ok(common.length > 0, "Could not find a common Turbopack resolver root for the fixture and installed SDK");
  const result = common.join(sep) || sep;
  assert.ok(isAbsolute(result));
  return result;
}

function copyCandidateSnapshot(snapshotRoot, runDir) {
  const tracked = gitFiles(["ls-files", "-z"]);
  const untracked = gitFiles(["ls-files", "--others", "--exclude-standard", "-z"]);
  const unexpected = untracked.filter(isRuntimePath).filter((path) => !isAllowedTaskUntracked(path));
  assert.deepEqual(unexpected, [], `Refusing to snapshot unlisted untracked runtime source: ${unexpected.join(", ")}`);
  const files = [...new Set([
    ...tracked.filter(shouldCopyRuntimeFile),
    ...untracked.filter(isAllowedTaskUntracked).filter(shouldCopyRuntimeFile),
  ])].sort();
  assert.ok(files.includes("next.config.ts"), "Candidate snapshot must contain next.config.ts");
  assert.ok(files.includes("package.json"), "Candidate snapshot must contain package.json");

  const totalBytes = files.reduce((sum, path) => {
    const entry = lstatSync(join(repoRoot, path));
    assert.ok(entry.isFile(), `Refusing non-regular source snapshot entry: ${path}`);
    return sum + entry.size;
  }, 0);
  assert.ok(totalBytes <= MAX_SOURCE_BYTES, `Candidate source snapshot exceeds ${MAX_SOURCE_BYTES} bytes: ${totalBytes}`);
  for (const path of files) {
    const source = join(repoRoot, path);
    const destination = join(snapshotRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }

  const modulesPath = realpathSync(join(repoRoot, "node_modules"));
  symlinkSync(modulesPath, join(snapshotRoot, "node_modules"), "dir");

  const sdkPath = realpathSync(join(repoRoot, "node_modules/@earendil-works/pi-coding-agent"));
  const resolverRoot = commonAncestor([snapshotRoot, sdkPath]);
  const configPath = join(snapshotRoot, "next.config.ts");
  let config = readFileSync(configPath, "utf8");
  const rootExpression = 'join(configDir, "../..")';
  const occurrences = config.split(rootExpression).length - 1;
  assert.equal(occurrences, 2, "Fixture-only Next config adaptation expected exactly the two existing ../.. roots");
  config = config.replaceAll(rootExpression, JSON.stringify(resolverRoot));
  writeFileSync(configPath, config);

  writeFileSync(join(runDir, "source-manifest.json"), JSON.stringify({
    repositoryHead: execFileSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    copiedFiles: files,
    copiedBytes: totalBytes,
    nodeModulesSymlink: modulesPath,
    installedSdkPath: sdkPath,
    fixtureOnlyTurbopackAndTracingRoot: resolverRoot,
    note: "No .local, .next, node_modules contents, docs, OpenSpec, or unrelated untracked files were copied.",
  }, null, 2));
  return { resolverRoot, copiedFiles: files, copiedBytes: totalBytes };
}

function reservePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  return once(server, "listening").then(() => {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    return new Promise((resolvePort, reject) => server.close((error) => error ? reject(error) : resolvePort(address.port)));
  });
}

async function listenLoopback(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return address.port;
}

function safeJson(text, label) {
  try { return JSON.parse(text); }
  catch { throw new Error(`${label} did not contain valid JSON`); }
}

function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part.text === "string") return part.text;
    if (part && typeof part.content === "string") return part.content;
    return "";
  }).join("\n");
}

function providerText(payload) {
  return (Array.isArray(payload?.messages) ? payload.messages : []).map(messageText).join("\n");
}

function messageWithMarker(payload, marker) {
  return (Array.isArray(payload?.messages) ? payload.messages : [])
    .map(messageText)
    .find((text) => text.includes(marker)) ?? "";
}

function count(text, needle) {
  if (!needle) return 0;
  return text.split(needle).length - 1;
}

function createFakeProvider() {
  const requests = [];
  const failures = [];
  let releaseGate;
  const gate = new Promise((resolveGate) => { releaseGate = resolveGate; });
  let resolveFirstTarget;
  const firstTarget = new Promise((resolveTarget) => { resolveFirstTarget = resolveTarget; });
  let gatedMainRequestSeen = false;
  const server = createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      failures.push(`Unexpected fake-provider endpoint ${request.method} ${request.url}`);
      response.writeHead(404).end("Not found");
      return;
    }
    if (request.headers.authorization !== `Bearer ${MODEL_API_KEY}`) {
      failures.push("Fake provider received a missing or unexpected Authorization header");
      response.writeHead(401).end("Unauthorized");
      return;
    }
    if (!request.headers["content-type"]?.includes("application/json")) {
      failures.push("Fake provider received a non-JSON request");
      response.writeHead(415).end("Expected JSON");
      return;
    }
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > MAX_PROVIDER_BODY_BYTES) {
        failures.push(`Provider request exceeded ${MAX_PROVIDER_BODY_BYTES} bytes`);
        response.writeHead(413).end("Too large");
        return;
      }
      chunks.push(chunk);
    }
    const payload = safeJson(Buffer.concat(chunks).toString("utf8"), "fake-provider request");
    if (requests.length >= MAX_PROVIDER_CALLS) {
      failures.push(`Provider call limit ${MAX_PROVIDER_CALLS} exceeded`);
      response.writeHead(429).end("Too many requests");
      return;
    }
    if (payload.model !== MODEL_ID || payload.stream !== true || !Array.isArray(payload.messages)) {
      failures.push(`Unexpected model/protocol payload: ${JSON.stringify({ model: payload.model, stream: payload.stream })}`);
      response.writeHead(422).end("Unexpected model or streaming payload");
      return;
    }
    const record = { payload, bytes, receivedAt: new Date().toISOString() };
    requests.push(record);
    const isMainRequest = providerText(payload).includes(MAIN_MARKER);
    if (isMainRequest && !gatedMainRequestSeen) {
      gatedMainRequestSeen = true;
      resolveFirstTarget(record);
    }
    if (isMainRequest) await gate;
    if (response.destroyed) return;

    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const chunk = {
      id: `inline-smoke-${requests.length}`,
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: { role: "assistant", content: FAUX_REPLY }, finish_reason: null }],
    };
    const finish = {
      id: `inline-smoke-${requests.length}`,
      object: "chat.completion.chunk",
      created: 0,
      model: MODEL_ID,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    response.write(`data: ${JSON.stringify(finish)}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  return {
    server,
    requests,
    failures,
    firstTarget,
    release() { releaseGate(); },
    async stop() {
      releaseGate();
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

function seedFixtures(agentDir, workspace, providerPort) {
  const alphaDir = join(agentDir, "skills/alpha");
  const betaDir = join(agentDir, "skills/beta");
  const gammaDir = join(agentDir, "skills/gamma");
  mkdirSync(alphaDir, { recursive: true });
  mkdirSync(betaDir, { recursive: true });
  mkdirSync(gammaDir, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  // Give the fixture its own discovery boundary. Otherwise the parent's Git
  // ignore rule for .local/ hides every test file from real @ completion.
  execFileSync("git", ["init", "--quiet", "--template=", workspace], {
    env: { ...safeWorkerEnvironment(), GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
  });
  writeFileSync(join(alphaDir, "SKILL.md"), [
    "---",
    "name: alpha",
    "description: Fixture alpha skill for inline mention smoke",
    "disable-model-invocation: true",
    "---",
    ALPHA_BODY,
    "Documentation-only token: $beta. It must not recursively include beta.",
    "",
  ].join("\n"));
  writeFileSync(join(betaDir, "SKILL.md"), [
    "---",
    "name: beta",
    "description: Fixture beta skill for inline mention smoke",
    "---",
    BETA_BODY,
    "",
  ].join("\n"));
  writeFileSync(join(gammaDir, "SKILL.md"), [
    "---",
    "name: gamma",
    "description: Fixture literal-only gamma skill for inline mention smoke",
    "---",
    GAMMA_BODY,
    "",
  ].join("\n"));
  writeFileSync(join(workspace, "inline-mention-target.txt"), "fixture-only @mention target\n");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({
    defaultProvider: MODEL_PROVIDER,
    defaultModel: MODEL_ID,
  }, null, 2));
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({
    providers: {
      [MODEL_PROVIDER]: {
        baseUrl: `http://127.0.0.1:${providerPort}/v1`,
        api: "openai-completions",
        apiKey: MODEL_API_KEY,
        models: [{
          id: MODEL_ID,
          name: "Inline Skills Loopback Fixture",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 256,
        }],
      },
    },
  }, null, 2));
}

function seedNextFontMock(runDir) {
  const mockPath = join(runDir, "next-font-mocks.cjs");
  // Next's supported test hook receives an empty stylesheet so Turbopack never
  // contacts Google Fonts or attempts to resolve a remote font-file import.
  writeFileSync(mockPath, `module.exports = ${JSON.stringify({ [GOOGLE_FONT_URL]: "" }, null, 2)};\n`);
  return mockPath;
}

function serverEnvironment(agentDir, fontMockPath) {
  return {
    ...safeWorkerEnvironment(),
    PI_CODING_AGENT_DIR: agentDir,
    PI_WEB_PASSWORD: "",
    // The optional npm update check is outside this offline skill-input seam.
    PI_WEB_SKIP_VERSION_CHECK: "1",
    NEXT_TELEMETRY_DISABLED: "1",
    NEXT_FONT_GOOGLE_MOCKED_RESPONSES: fontMockPath,
    HISTFILE: "/dev/null",
    SHELL: "/bin/bash",
  };
}

async function waitUntil(description, predicate, timeoutMs = 30_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last;
    await delay(intervalMs);
  }
  throw new Error(`Timed out waiting for ${description}${last ? `; last=${JSON.stringify(last)}` : ""}`);
}

async function waitForReady(base, child, childExit, logPath) {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Isolated Next dev exited before readiness (${child.exitCode ?? child.signalCode}); see ${logPath}`);
    }
    try {
      const response = await fetch(`${base}/api/sessions`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  const stopped = await stopProcess(child, childExit);
  if (!stopped) throw new Error(`Isolated Next dev process group ${child.pid} survived readiness-timeout cleanup; see ${logPath}`);
  throw new Error(`Isolated Next dev readiness timed out; see ${logPath}`);
}

function processGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    throw error;
  }
}

async function waitForProcessGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processGroupExists(pid)) return true;
    await delay(100);
  }
  return !processGroupExists(pid);
}

const processStopTasks = new WeakMap();
async function stopProcess(child, exitPromise) {
  if (!child?.pid) return true;
  const previous = processStopTasks.get(child);
  if (previous) return previous;
  const stopping = (async () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    if (!(await waitForProcessGroupExit(child.pid, 10_000))) {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
      if (!(await waitForProcessGroupExit(child.pid, 5000))) return false;
    }
    if (exitPromise) await Promise.race([exitPromise.then(() => undefined).catch(() => {}), delay(1000)]);
    return !processGroupExists(child.pid);
  })();
  processStopTasks.set(child, stopping);
  return stopping;
}

function visibleChoice(page, text) {
  // The explorer may contain the same file name before @ completion has loaded.
  return page.locator(".chat-input-shell").getByText(text, { exact: false }).last();
}

async function placeCaret(textarea, value, position) {
  await textarea.evaluate((element, args) => {
    if (element.value !== args.value) throw new Error("Composer value changed before caret placement");
    element.focus();
    element.setSelectionRange(args.position, args.position);
    element.dispatchEvent(new Event("select", { bubbles: true }));
  }, { value, position });
  // React's onSelect is driven by native keyboard/selectionchange events, not
  // a synthetic DOM `select` event. Exercise real caret movement as a user does.
  await textarea.press(position > 0 ? "ArrowLeft" : "ArrowRight");
  await textarea.press(position > 0 ? "ArrowRight" : "ArrowLeft");
}

// Attach a rejection observer immediately; still return the original promise
// so its later await preserves failures. Teardown must not mask the first error.
function observedWait(promise) {
  void promise.catch(() => {});
  return promise;
}

async function runSmoke() {
  mkdirSync(qualificationRoot, { recursive: true });
  process.env.PLAYWRIGHT_BROWSERS_PATH = browserCache;
  const { chromium } = await import("playwright");
  if (pendingSignal) return;
  if (process.platform !== "linux" || process.arch !== "x64") {
    console.error(`BLOCKED_BROWSER_PLATFORM: this qualification cache contains only Linux x64 Chromium Headless Shell (got ${process.platform}/${process.arch})`);
    process.exitCode = 2;
    return;
  }
  const browserRegistry = JSON.parse(readFileSync(join(repoRoot, "node_modules/playwright-core/browsers.json"), "utf8"));
  const shellRevision = browserRegistry.browsers.find((entry) => entry.name === "chromium-headless-shell")?.revision;
  if (!shellRevision) {
    console.error("BLOCKED_BROWSER_SETUP: installed Playwright registry has no chromium-headless-shell revision");
    process.exitCode = 2;
    return;
  }
  const browserExecutable = join(browserCache, `chromium_headless_shell-${shellRevision}`, "chrome-headless-shell-linux64", "chrome-headless-shell");
  if (!existsSync(browserExecutable)) {
    console.error(`BLOCKED_BROWSER: installed Playwright Headless Shell executable is missing: ${browserExecutable}`);
    console.error("No Next server, profile, or source snapshot was started.");
    process.exitCode = 2;
    return;
  }
  let preflightBrowser;
  stopActiveSmoke = () => { void preflightBrowser?.close().catch(() => {}); };
  try {
    preflightBrowser = await chromium.launch({
      headless: true,
      executablePath: browserExecutable,
      timeout: 30_000,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });
    await preflightBrowser.close();
  } catch (error) {
    await preflightBrowser?.close().catch(() => {});
    if (!pendingSignal) {
      console.error(`BLOCKED_BROWSER_LAUNCH: installed Headless Shell could not launch; no Next server, profile, or source snapshot was started. ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
    return;
  } finally {
    stopActiveSmoke = () => {};
  }
  if (pendingSignal) return;
  console.log(`HEADLESS_EXECUTABLE=${browserExecutable}`);

  const runDir = join(qualificationRoot, `run-${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`);
  mkdirSync(runDir, { recursive: true });
  const sourceRoot = join(runDir, "source");
  mkdirSync(sourceRoot, { recursive: true });
  const workspace = join(runDir, "workspace");
  const agentDir = join(runDir, "agent");
  mkdirSync(agentDir, { recursive: true });
  const serverLogPath = join(runDir, "next-dev.log");
  const serverLog = createWriteStream(serverLogPath);
  const fontMockPath = seedNextFontMock(runDir);
  const provider = createFakeProvider();
  const evidence = {
    status: "running",
    startedAt: new Date().toISOString(),
    browserExecutable,
    playwrightVersion: JSON.parse(readFileSync(join(repoRoot, "node_modules/playwright/package.json"), "utf8")).version,
    apiCommands: [],
    providerFailures: provider.failures,
    browserErrors: [],
    nextFontMockPath: fontMockPath,
    nextFontMockMode: "empty Noto Sans Mono stylesheet via Next test hook (no external font fetch)",
  };
  let browser;
  let context;
  let page;
  let nextServer;
  let nextExit;
  let resolverRoot;
  let base;
  let providerPort;
  let sessionId;
  let failed;
  let timedOut = false;
  const runtimeTimer = setTimeout(() => {
    timedOut = true;
    console.error(`RUN_TIMEOUT: isolated inline-skills smoke exceeded ${MAX_RUNTIME_MS}ms`);
    stopActiveSmoke();
  }, MAX_RUNTIME_MS);
  runtimeTimer.unref();
  stopActiveSmoke = () => {
    provider.release();
    void context?.close().catch(() => {});
    void browser?.close().catch(() => {});
    void stopProcess(nextServer, nextExit).then((stopped) => {
      if (!stopped) console.error(`PROCESS_GROUP_CLEANUP_FAILED: Next process group ${nextServer?.pid} did not exit`);
    }).catch((error) => {
      console.error(`PROCESS_GROUP_CLEANUP_ERROR: ${error instanceof Error ? error.message : String(error)}`);
    });
  };

  try {
    if (pendingSignal) { evidence.status = "INTERRUPTED"; return; }
    const snapshot = copyCandidateSnapshot(sourceRoot, runDir);
    resolverRoot = snapshot.resolverRoot;
    providerPort = await listenLoopback(provider.server);
    seedFixtures(agentDir, workspace, providerPort);
    const port = await reservePort();
    base = `http://127.0.0.1:${port}`;
    if (pendingSignal) { evidence.status = "INTERRUPTED"; return; }
    const nextBin = join(sourceRoot, "node_modules/next/dist/bin/next");
    assert.ok(existsSync(nextBin), `Missing installed Next CLI at ${nextBin}`);
    nextServer = spawn(process.execPath, [nextBin, "dev", "-H", "127.0.0.1", "-p", String(port)], {
      cwd: sourceRoot,
      env: serverEnvironment(agentDir, fontMockPath),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    nextExit = once(nextServer, "exit");
    nextServer.stdout.pipe(serverLog, { end: false });
    nextServer.stderr.pipe(serverLog, { end: false });
    evidence.nextPid = nextServer.pid;
    evidence.nextProcessGroupId = nextServer.pid;
    evidence.nextPort = port;
    evidence.fakeProviderPort = providerPort;
    evidence.sourceRoot = sourceRoot;
    evidence.turbopackRoot = resolverRoot;
    evidence.serverLog = serverLogPath;
    console.log(`RUN_DIR=${runDir}`);
    console.log(`SOURCE_SNAPSHOT=${sourceRoot}`);
    console.log(`NEXT_PID=${nextServer.pid}`);
    console.log(`NEXT_URL=${base}`);
    console.log(`FAKE_PROVIDER=127.0.0.1:${providerPort}`);
    console.log(`FIXTURE_TURBOPACK_ROOT=${resolverRoot}`);
    console.log(`NEXT_FONT_MOCK=${fontMockPath} mode=empty-response-no-network`);

    await waitForReady(base, nextServer, nextExit, serverLogPath);
    const ensureResponse = await fetch(`${base}/api/agent/new`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "ensure_session",
        cwd: workspace,
        provider: MODEL_PROVIDER,
        modelId: MODEL_ID,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const ensureBody = await ensureResponse.json();
    assert.equal(ensureResponse.status, 200, `ensure_session failed: ${JSON.stringify(ensureBody)}`);
    assert.equal(ensureBody.success, true, `ensure_session failed: ${JSON.stringify(ensureBody)}`);
    assert.equal(ensureBody.model?.provider, MODEL_PROVIDER);
    assert.equal(ensureBody.model?.modelId, MODEL_ID);
    const workspaceSessionId = ensureBody.sessionId;
    assert.equal(typeof workspaceSessionId, "string");
    evidence.workspaceAuthorizationSessionId = workspaceSessionId;
    evidence.workspaceAuthorizationStatus = ensureResponse.status;

    browser = await chromium.launch({ headless: true, executablePath: browserExecutable, timeout: 30_000, args: ["--no-sandbox", "--disable-setuid-sandbox"] });
    context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "en-US", serviceWorkers: "block" });
    await context.addInitScript(() => {
      if (location.origin.startsWith("http")) localStorage.setItem("pi-enter-send-mode", "enter");
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    page.setDefaultNavigationTimeout(90_000);
    page.on("pageerror", (error) => evidence.browserErrors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") evidence.browserErrors.push(message.text());
    });
    page.on("request", (request) => {
      if (request.method() !== "POST" || !sessionId) return;
      const url = new URL(request.url());
      if (url.origin !== base || !url.pathname.startsWith(`/api/agent/${encodeURIComponent(sessionId)}`)) return;
      let body;
      try { body = request.postDataJSON(); } catch { return; }
      if (body?.type === "prompt") evidence.apiCommands.push({ url: url.pathname, body });
    });
    const browserEnsureResponse = observedWait(page.waitForResponse((response) => {
      if (response.request().method() !== "POST" || new URL(response.url()).pathname !== "/api/agent/new") return false;
      try { return response.request().postDataJSON()?.type === "ensure_session"; }
      catch { return false; }
    }, { timeout: 60_000 }));

    await page.goto(`${base}/?cwd=${encodeURIComponent(workspace)}`, { waitUntil: "domcontentloaded" });
    const textarea = page.locator(".chat-input-textarea");
    await textarea.waitFor({ state: "visible" });

    // Fresh-session catalog: the first dollar completion must come from this
    // session's loaded skill commands, before any prompt reaches the provider.
    const keyboardDraft = "Before $bet after the suffix";
    await textarea.fill(keyboardDraft);
    const keyboardCaret = keyboardDraft.indexOf("$bet") + "$bet".length;
    await placeCaret(textarea, keyboardDraft, keyboardCaret);
    await visibleChoice(page, "beta").waitFor({ state: "visible" });
    const browserEnsureResult = await browserEnsureResponse;
    const browserEnsureBody = await browserEnsureResult.json();
    assert.equal(browserEnsureResult.status(), 200, `browser ensure_session failed: ${JSON.stringify(browserEnsureBody)}`);
    assert.equal(browserEnsureBody.success, true, `browser ensure_session failed: ${JSON.stringify(browserEnsureBody)}`);
    assert.equal(browserEnsureBody.model?.provider, MODEL_PROVIDER);
    assert.equal(browserEnsureBody.model?.modelId, MODEL_ID);
    sessionId = browserEnsureBody.sessionId;
    assert.equal(typeof sessionId, "string");
    evidence.sessionId = sessionId;
    evidence.browserEnsureSessionStatus = browserEnsureResult.status();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    const keyboardCompleted = "Before $beta after the suffix";
    assert.equal(await textarea.inputValue(), keyboardCompleted, "keyboard completion should replace only the partial reference");
    assert.equal(await textarea.evaluate((element) => element.selectionStart), keyboardCompleted.indexOf("$beta") + "$beta".length, "keyboard completion should put the caret after the token");
    assert.equal(evidence.apiCommands.length, 0, "choosing a dollar suggestion must not submit");

    const pointerDraft = "Use $beta and $al with the trailing text";
    await textarea.fill(pointerDraft);
    const pointerCaret = pointerDraft.indexOf("$al") + "$al".length;
    await placeCaret(textarea, pointerDraft, pointerCaret);
    await visibleChoice(page, "alpha").waitFor({ state: "visible" });
    await page.screenshot({ path: join(runDir, "skill-completion.png") });
    await visibleChoice(page, "alpha").click();
    const pointerCompleted = "Use $beta and $alpha with the trailing text";
    assert.equal(await textarea.inputValue(), pointerCompleted, "pointer completion should preserve both prefix and suffix");
    assert.equal(await textarea.evaluate((element) => element.selectionStart), pointerCompleted.indexOf("$alpha") + "$alpha".length, "pointer completion should put the caret after the token");
    assert.equal(evidence.apiCommands.length, 0, "pointer completion must not submit");

    // Existing command and file completion remain reachable in this fresh session.
    await textarea.fill("/skill:al");
    await visibleChoice(page, "alpha").waitFor({ state: "visible" });
    await visibleChoice(page, "alpha").click();
    assert.equal(await textarea.inputValue(), "/skill:alpha ", "existing /skill command completion should retain its trailing argument separator");
    await textarea.fill("@inline-mention");
    await visibleChoice(page, "inline-mention-target.txt").waitFor({ state: "visible" });
    await visibleChoice(page, "inline-mention-target.txt").click();
    assert.match(await textarea.inputValue(), /inline-mention-target\.txt/, "existing @ file completion should remain intact");
    assert.equal(evidence.apiCommands.length, 0, "slash and @ completion selection must not submit");

    const mainPrompt = `${MAIN_MARKER}: preserve the list-fence literal.
- \`\`\`sh
  echo $alpha
  echo $gamma
  \`\`\`
Use $beta, then $beta.
Unknown: $unknown; escaped: \\$alpha; inline code: \`$alpha\`.
Currency: $20; doubled: $$alpha; path: /tmp/$alpha; embedded: word$alpha.
Fenced code:
\`\`\`text
$beta
\`\`\`
Slash literal: /skill:alpha`;
    await textarea.fill(mainPrompt);
    const mainPost = observedWait(page.waitForRequest((request) => {
      if (request.method() !== "POST" || !request.url().includes(`/api/agent/${encodeURIComponent(sessionId)}`)) return false;
      try { const body = request.postDataJSON(); return body?.type === "prompt" && body?.message?.includes(MAIN_MARKER); }
      catch { return false; }
    }));
    await textarea.press("Enter");
    await mainPost;

    const targetRequest = await Promise.race([
      provider.firstTarget,
      delay(45_000).then(() => { throw new Error("Timed out waiting for the main prompt at the fake provider"); }),
    ]);
    const mainTurnText = messageWithMarker(targetRequest.payload, MAIN_MARKER);
    assert.ok(mainTurnText.includes(MAIN_MARKER), "the actual Web prompt must reach the fake provider");
    const agentPath = `/api/agent/${encodeURIComponent(sessionId)}`;
    await waitUntil("the session entering streaming state", async () => {
      const response = await fetch(`${base}${agentPath}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!response?.ok) return false;
      const body = await response.json();
      return body.running && body.state?.isStreaming === true;
    }, 30_000);

    const waitForQueuedPost = (behavior) => observedWait(page.waitForResponse((response) => {
      try {
        const request = response.request();
        const body = request.postDataJSON();
        return response.url().includes(agentPath)
          && request.method() === "POST"
          && body?.type === "prompt"
          && body?.streamingBehavior === behavior;
      } catch { return false; }
    }, { timeout: 30_000 }));

    const steerPrompt = `${STEER_MARKER}: $alpha before $beta and $alpha again queued`;
    const steerResponse = waitForQueuedPost("steer");
    await textarea.fill(steerPrompt);
    await textarea.press("Enter");
    const steerResult = await steerResponse;
    assert.equal(steerResult.status(), 200, "steering input should be accepted by the real Web API");

    const followUpPrompt = `${FOLLOW_UP_MARKER}: $beta before $alpha queued`;
    const followUpResponse = waitForQueuedPost("followUp");
    await textarea.fill(followUpPrompt);
    await textarea.press("Alt+Enter");
    const followUpResult = await followUpResponse;
    assert.equal(followUpResult.status(), 200, "follow-up input should be accepted by the real Web API");
    assert.deepEqual(
      evidence.apiCommands.filter(({ body }) => body.streamingBehavior).map(({ body }) => ({ behavior: body.streamingBehavior, message: body.message })),
      [
        { behavior: "steer", message: steerPrompt },
        { behavior: "followUp", message: followUpPrompt },
      ],
      "the browser must preserve distinct steer and follow-up modes",
    );

    provider.release();
    await waitUntil("both queued messages reaching the fake provider", async () => {
      const bodies = provider.requests.map(({ payload }) => providerText(payload));
      return bodies.some((text) => text.includes(STEER_MARKER)) && bodies.some((text) => text.includes(FOLLOW_UP_MARKER));
    }, 60_000);
    await page.getByText(FAUX_REPLY, { exact: true }).last().waitFor({ state: "visible", timeout: 60_000 });
    await waitUntil("the session completing the queued turns", async () => {
      const response = await fetch(`${base}${agentPath}`, { signal: AbortSignal.timeout(5000) }).catch(() => null);
      if (!response?.ok) return false;
      const body = await response.json();
      return body.running && body.state?.isStreaming === false;
    }, 60_000);

    // Also close the ordinary, non-streaming two-skill case through the browser.
    const normalMultiPrompt = `${NORMAL_MULTI_MARKER}: use $beta, $alpha and $beta.`;
    const normalResponse = observedWait(page.waitForResponse((response) => {
      try {
        const body = response.request().postDataJSON();
        return response.request().method() === "POST" && response.url().includes(agentPath)
          && body?.type === "prompt" && body?.message === normalMultiPrompt;
      } catch { return false; }
    }));
    await textarea.fill(normalMultiPrompt);
    await textarea.press("Enter");
    assert.equal((await normalResponse).status(), 200, "ordinary multi-skill input should be accepted");
    await waitUntil("ordinary multi-skill terminal reply", async () => {
      const reached = provider.requests.some(({ payload }) => messageWithMarker(payload, NORMAL_MULTI_MARKER));
      return reached && await page.getByText(FAUX_REPLY, { exact: true }).count() >= 4;
    }, 60_000);

    const normalBubble = page.locator(".markdown-user-message").filter({ hasText: NORMAL_MULTI_MARKER });
    assert.ok((await normalBubble.textContent()).includes(normalMultiPrompt), "rendered skill names must retain literal dollars, not become inline math");
    assert.equal(await normalBubble.locator(".katex").count(), 0, "skill references are not math expressions");

    const turnExpectations = new Map([
      [NORMAL_MULTI_MARKER, { alpha: 1, beta: 1, gamma: 0 }],
      [MAIN_MARKER, { alpha: 0, beta: 1, gamma: 0 }],
      [STEER_MARKER, { alpha: 1, beta: 1, gamma: 0 }],
      [FOLLOW_UP_MARKER, { alpha: 1, beta: 1, gamma: 0 }],
    ]);
    const turnMessages = new Map();
    for (const { payload } of provider.requests) {
      for (const marker of turnExpectations.keys()) {
        if (turnMessages.has(marker)) continue;
        const text = messageWithMarker(payload, marker);
        if (text) turnMessages.set(marker, text);
      }
    }
    assert.deepEqual([...turnMessages.keys()].sort(), [...turnExpectations.keys()].sort(), "main, steering and follow-up user messages should all reach the SDK consumer despite repeated history");
    for (const marker of [NORMAL_MULTI_MARKER, STEER_MARKER, FOLLOW_UP_MARKER]) {
      const turnText = turnMessages.get(marker);
      assert.equal(count(turnText, ALPHA_BODY), 1, `${marker} should expand alpha once within its own user message`);
      assert.equal(count(turnText, BETA_BODY), 1, `${marker} should expand beta once within its own user message`);
      assert.equal(count(turnText, GAMMA_BODY), 0, `${marker} should not expand the literal-only gamma skill`);
    }
    assert.ok(turnMessages.get(STEER_MARKER).indexOf(ALPHA_BODY) < turnMessages.get(STEER_MARKER).indexOf(BETA_BODY), "steer skill bodies should follow first-reference order");
    assert.ok(turnMessages.get(FOLLOW_UP_MARKER).indexOf(BETA_BODY) < turnMessages.get(FOLLOW_UP_MARKER).indexOf(ALPHA_BODY), "follow-up skill bodies should follow first-reference order");
    assert.ok(turnMessages.get(NORMAL_MULTI_MARKER).indexOf(BETA_BODY) < turnMessages.get(NORMAL_MULTI_MARKER).indexOf(ALPHA_BODY), "ordinary multi-skill input should retain first-reference order");
    assert.ok(provider.failures.length === 0, `fake provider errors: ${provider.failures.join("; ")}`);

    const sessionResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1`);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200, "the final SDK session transcript should be readable through the Web API");
    const transcript = JSON.stringify(sessionBody.context?.messages ?? []);
    for (const marker of [MAIN_MARKER, NORMAL_MULTI_MARKER, STEER_MARKER, FOLLOW_UP_MARKER, FAUX_REPLY]) {
      assert.ok(transcript.includes(marker), `terminal transcript should contain ${marker}`);
    }
    assert.deepEqual(evidence.browserErrors, [], `browser errors: ${evidence.browserErrors.join("; ")}`);

    const mainSkillTurn = turnMessages.get(MAIN_MARKER);
    assert.deepEqual({
      alpha: count(mainSkillTurn, ALPHA_BODY),
      beta: count(mainSkillTurn, BETA_BODY),
      gamma: count(mainSkillTurn, GAMMA_BODY),
    }, { alpha: 0, beta: 1, gamma: 0 }, "list-contained fence must keep alpha/gamma literal while the following live beta reference expands once");
    assert.ok(mainSkillTurn.includes(join(agentDir, "skills/beta")), "beta's registered location should reach the consumer");
    for (const skill of ["alpha", "gamma"]) {
      assert.ok(!mainSkillTurn.includes(join(agentDir, `skills/${skill}`)), `${skill} must remain literal-only in the main message`);
    }
    for (const literal of [
      "$unknown",
      String.raw`\$alpha`,
      "`$alpha`",
      "$20",
      "$$alpha",
      "/tmp/$alpha",
      "word$alpha",
      "  echo $alpha\n  echo $gamma\n",
      "Use $beta, then $beta.",
      "```text\n$beta\n```",
      "/skill:alpha",
    ]) assert.ok(mainSkillTurn.includes(literal), `original literal should remain in the model input: ${JSON.stringify(literal)}`);

    await page.screenshot({ path: join(runDir, "terminal.png"), fullPage: true });
    evidence.status = "PASS";
    evidence.providerRequestCount = provider.requests.length;
    evidence.apiPromptCommands = evidence.apiCommands;
    evidence.transcriptStatus = sessionResponse.status;
    evidence.completedAt = new Date().toISOString();
    console.log(`PASS: browser completion, real Web API, SDK expansion/dedup, literal preservation, steer/followUp, terminal transcript (${provider.requests.length} fake-provider request(s))`);
  } catch (error) {
    failed = error;
    evidence.failure = error instanceof Error ? { message: error.message, stack: error.stack } : String(error);
    if (timedOut) {
      evidence.status = "TIMEOUT";
      process.exitCode = 1;
    } else if (pendingSignal) {
      evidence.status = "INTERRUPTED";
      process.exitCode = pendingSignal === "SIGINT" ? 130 : 143;
    } else {
      evidence.status = "FAIL";
      if (page) await page.screenshot({ path: join(runDir, "failure.png"), fullPage: true }).catch(() => {});
      process.exitCode = 1;
    }
  } finally {
    provider.release();
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
    const processGroupStopped = await stopProcess(nextServer, nextExit).catch((error) => {
      evidence.cleanupError = error instanceof Error ? error.message : String(error);
      return false;
    });
    evidence.nextProcessGroupStopped = processGroupStopped;
    if (!processGroupStopped) {
      evidence.status = "CLEANUP_FAILURE";
      process.exitCode = 1;
    }
    await provider.stop().catch((error) => {
      evidence.providerCleanupError = error instanceof Error ? error.message : String(error);
    });
    clearTimeout(runtimeTimer);
    stopActiveSmoke = () => {};
    serverLog.end();
    evidence.completedAt ??= new Date().toISOString();
    evidence.serverExitCode = nextServer?.exitCode ?? null;
    evidence.serverSignal = nextServer?.signalCode ?? null;
    evidence.fakeProviderRequestCount = provider.requests.length;
    evidence.apiPromptCommands = evidence.apiCommands;
    evidence.sourceRoot = sourceRoot;
    evidence.turbopackRoot = resolverRoot;
    evidence.serverLog = serverLogPath;
    if (base) evidence.webBaseUrl = base;
    if (providerPort) evidence.fakeProviderPort = providerPort;
    const summary = Object.fromEntries(Object.entries(evidence).filter(([key]) => key !== "apiCommands"));
    summary.apiCommandCount = evidence.apiCommands.length;
    summary.apiCommandModes = evidence.apiCommands.map(({ body }) => body.streamingBehavior ?? "prompt");
    writeFileSync(join(runDir, "evidence.json"), JSON.stringify(summary, null, 2));
    writeFileSync(join(runDir, "provider-requests.json"), JSON.stringify(provider.requests.map(({ payload, bytes, receivedAt }) => ({ payload, bytes, receivedAt })), null, 2));
    writeFileSync(join(runDir, "web-api-prompt-commands.json"), JSON.stringify(evidence.apiCommands, null, 2));
    console.log(`STATUS=${evidence.status}`);
    console.log(`EVIDENCE=${join(runDir, "evidence.json")}`);
    console.log(`PROVIDER_REQUESTS=${join(runDir, "provider-requests.json")}`);
    console.log(`WEB_API_COMMANDS=${join(runDir, "web-api-prompt-commands.json")}`);
    console.log(`NEXT_LOG=${serverLogPath}`);
    if (failed) console.error(failed.stack ?? String(failed));
  }
}

if (process.argv[2] === workerArg) {
  process.once("SIGINT", () => requestWorkerShutdown("SIGINT"));
  process.once("SIGTERM", () => requestWorkerShutdown("SIGTERM"));
  await runSmoke();
} else {
  startSanitizedWorker();
}
