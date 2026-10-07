// Task 3.1: real browser composer -> Pi Web API -> installed SDK -> loopback fake provider.
// Run with: node e2e/inline-skills.mjs
// The task-authorized old-behavior RED control uses --baseline-93cc3c0.
// The child process uses a sanitized environment and a private source snapshot. It
// never builds or starts the active checkout's Next.js instance.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync, copyFileSync, symlinkSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const qualificationRoot = join(repoRoot, ".local/qualification/inline-skill-context");
// Reuse the previously installed local browser binary without writing to its
// older qualification evidence directory.
const browserCache = join(repoRoot, ".local/qualification/inline-skills/browser-cache");
const workerArg = "--isolated-worker";
const baselineFlag = "--baseline-93cc3c0";
const baselineRef = "93cc3c0";
const MAX_SOURCE_BYTES = 200 * 1024 * 1024;
const MAX_PROVIDER_BODY_BYTES = 2 * 1024 * 1024;
const MAX_PROVIDER_CALLS = 12;
const MAX_RUNTIME_MS = 12 * 60_000;
const MAIN_MARKER = "INLINE_SMOKE_MAIN_REQUEST";
const STEER_MARKER = "INLINE_SMOKE_STEER_REQUEST";
const FOLLOW_UP_MARKER = "INLINE_SMOKE_FOLLOW_UP_REQUEST";
const NORMAL_MULTI_MARKER = "INLINE_SMOKE_NORMAL_MULTI_REQUEST";
const LEGACY_MARKER = "INLINE_SMOKE_LEGACY_HISTORY";
const LEGACY_SESSION_ID = "inline-skill-legacy-history";
const ALPHA_BODY = "INLINE_SMOKE_ALPHA_BODY_SENTINEL";
const BETA_BODY = "INLINE_SMOKE_BETA_BODY_SENTINEL";
const GAMMA_BODY = "INLINE_SMOKE_GAMMA_BODY_SENTINEL";
const INLINE_IMAGE_NAME = "inline-skill-context.png";
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
  const args = [fileURLToPath(import.meta.url), workerArg];
  if (process.argv.includes(baselineFlag)) args.push(baselineFlag);
  const child = spawn(process.execPath, args, {
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

function gitBuffer(args, options = {}) {
  return execFileSync("git", ["-C", repoRoot, ...args], {
    encoding: "buffer",
    maxBuffer: MAX_SOURCE_BYTES,
    ...options,
  });
}

function gitFiles(args) {
  return gitBuffer(args).toString("utf8").split("\0").filter(Boolean);
}

function gitTreeEntries(ref) {
  return gitBuffer(["ls-tree", "-r", "-z", ref]).toString("utf8").split("\0").filter(Boolean).map((record) => {
    const tab = record.indexOf("\t");
    assert.ok(tab > 0, `Malformed git tree entry for ${ref}`);
    const [mode, type, oid] = record.slice(0, tab).split(" ");
    return { mode, type, oid, path: record.slice(tab + 1) };
  });
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

function copyCandidateSnapshot(snapshotRoot, runDir, requestedBaseline = null) {
  let files;
  let totalBytes;
  let baselineEntries;
  if (requestedBaseline) {
    assert.equal(requestedBaseline, baselineRef, "Only the task-authorized baseline may be selected");
    baselineEntries = gitTreeEntries(requestedBaseline);
    const runtimeEntries = baselineEntries.filter(({ path }) => shouldCopyRuntimeFile(path));
    for (const entry of runtimeEntries) {
      assert.ok(entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755"),
        `Refusing non-regular baseline source entry: ${entry.path}`);
    }
    files = runtimeEntries.map(({ path }) => path).sort();
    const sizes = execFileSync("git", ["-C", repoRoot, "cat-file", "--batch-check=%(objectname) %(objectsize)"], {
      input: `${runtimeEntries.map(({ oid }) => oid).join("\n")}\n`,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    }).trim().split(/\r?\n/).map((line) => Number(line.split(" ").at(-1)));
    assert.equal(sizes.length, runtimeEntries.length, "Baseline blob-size listing should align with runtime entries");
    totalBytes = sizes.reduce((sum, size) => sum + size, 0);
    assert.ok(totalBytes <= MAX_SOURCE_BYTES, `Baseline source snapshot exceeds ${MAX_SOURCE_BYTES} bytes: ${totalBytes}`);
  } else {
    const tracked = gitFiles(["ls-files", "-z"]);
    const untracked = gitFiles(["ls-files", "--others", "--exclude-standard", "-z"]);
    const unexpected = untracked.filter(isRuntimePath).filter((path) => !isAllowedTaskUntracked(path));
    assert.deepEqual(unexpected, [], `Refusing to snapshot unlisted untracked runtime source: ${unexpected.join(", ")}`);
    files = [...new Set([
      ...tracked.filter(shouldCopyRuntimeFile),
      ...untracked.filter(isAllowedTaskUntracked).filter(shouldCopyRuntimeFile),
    ])].sort();
    totalBytes = files.reduce((sum, path) => {
      const entry = lstatSync(join(repoRoot, path));
      assert.ok(entry.isFile(), `Refusing non-regular source snapshot entry: ${path}`);
      return sum + entry.size;
    }, 0);
    assert.ok(totalBytes <= MAX_SOURCE_BYTES, `Candidate source snapshot exceeds ${MAX_SOURCE_BYTES} bytes: ${totalBytes}`);
  }
  assert.ok(files.includes("next.config.ts"), "Source snapshot must contain next.config.ts");
  assert.ok(files.includes("package.json"), "Source snapshot must contain package.json");

  const baselineByPath = new Map(baselineEntries?.map((entry) => [entry.path, entry]) ?? []);
  for (const path of files) {
    const destination = join(snapshotRoot, path);
    mkdirSync(dirname(destination), { recursive: true });
    if (requestedBaseline) {
      const entry = baselineByPath.get(path);
      assert.ok(entry, `Missing baseline blob for ${path}`);
      writeFileSync(destination, gitBuffer(["cat-file", "blob", entry.oid]));
    } else {
      copyFileSync(join(repoRoot, path), destination);
    }
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

  const sourceHead = gitBuffer(["rev-parse", requestedBaseline ?? "HEAD"]).toString("utf8").trim();
  const testScriptPath = fileURLToPath(import.meta.url);
  const testScriptSha256 = createHash("sha256").update(readFileSync(testScriptPath)).digest("hex");
  writeFileSync(join(runDir, "source-manifest.json"), JSON.stringify({
    repositoryHead: sourceHead,
    sourceMode: requestedBaseline ? "authorized-baseline" : "candidate-worktree",
    requestedBaseline,
    e2eScriptPath: testScriptPath,
    e2eScriptSha256: testScriptSha256,
    copiedFiles: files,
    copiedBytes: totalBytes,
    nodeModulesSymlink: modulesPath,
    installedSdkPath: sdkPath,
    fixtureOnlyTurbopackAndTracingRoot: resolverRoot,
    note: "No .local, .next, node_modules contents, docs, OpenSpec, or unrelated untracked files were copied.",
  }, null, 2));
  return { resolverRoot, copiedFiles: files, copiedBytes: totalBytes, sourceHead, requestedBaseline, testScriptSha256 };
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
  }).filter((text) => text.length > 0).join("\n");
}

function providerText(payload) {
  return (Array.isArray(payload?.messages) ? payload.messages : []).map(messageText).join("\n");
}

function messageWithMarker(payload, marker) {
  return (Array.isArray(payload?.messages) ? payload.messages : [])
    .map(messageText)
    .find((text) => text.includes(marker)) ?? "";
}

function providerUserMessageIndex(messages, marker) {
  const matches = [];
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role === "user" && messageText(message).includes(marker)) matches.push(index);
  }
  assert.equal(matches.length, 1, `provider request should contain one originating user message for ${marker}`);
  return matches[0];
}

function skillContextMessagesAfter(messages, userIndex) {
  const result = [];
  for (let index = userIndex + 1; index < messages.length; index++) {
    const message = messages[index];
    if (message?.role !== "user" || !messageText(message).startsWith('<skill name="')) break;
    result.push(message);
  }
  return result;
}

function contextWrapper({ name, filePath, baseDir, body }) {
  return `<skill name="${name}" location="${filePath}">\nReferences are relative to ${baseDir}.\n\n${body}\n</skill>`;
}

function expectedSkillMetadata(agentDir, name) {
  const skillDir = join(agentDir, "skills", name);
  const body = name === "alpha"
    ? `${ALPHA_BODY}\nDocumentation-only token: $beta. It must not recursively include beta.`
    : name === "beta" ? BETA_BODY : GAMMA_BODY;
  return { name, filePath: join(skillDir, "SKILL.md"), baseDir: skillDir, body };
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
          input: ["text", "image"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 256,
        }],
      },
    },
  }, null, 2));
  return seedLegacyHistory(agentDir, workspace);
}

function seedLegacyHistory(agentDir, workspace) {
  const timestamp = "2026-10-11T00:00:00.000Z";
  const prompt = `${LEGACY_MARKER}: legacy short prompt uses $beta and $alpha.`;
  const legacyText = `${prompt}\n\n${contextWrapper(expectedSkillMetadata(agentDir, "beta"))}\n\n${contextWrapper(expectedSkillMetadata(agentDir, "alpha"))}`;
  const sessionDir = join(agentDir, "sessions", "inline-skill-context");
  mkdirSync(sessionDir, { recursive: true });
  const entries = [
    { type: "session", version: 3, id: LEGACY_SESSION_ID, timestamp, cwd: workspace },
    { type: "message", id: "legacy-user", parentId: null, timestamp, message: { role: "user", content: legacyText } },
  ];
  const sessionFile = join(sessionDir, `${timestamp.replaceAll(":", "-")}_${LEGACY_SESSION_ID}.jsonl`);
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return { prompt, legacyText, sessionFile };
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
  let inlineImageBase64;
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
    const requestedBaseline = process.argv.includes(baselineFlag) ? baselineRef : null;
    const snapshot = copyCandidateSnapshot(sourceRoot, runDir, requestedBaseline);
    resolverRoot = snapshot.resolverRoot;
    evidence.repositoryHead = snapshot.sourceHead;
    evidence.sourceMode = requestedBaseline ? "authorized-baseline" : "candidate-worktree";
    evidence.requestedBaseline = requestedBaseline;
    evidence.e2eScriptSha256 = snapshot.testScriptSha256;
    providerPort = await listenLoopback(provider.server);
    const legacyFixture = seedFixtures(agentDir, workspace, providerPort);
    evidence.legacySessionId = LEGACY_SESSION_ID;
    evidence.legacySessionFile = legacyFixture.sessionFile;
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
    await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
    await context.addInitScript(() => {
      if (!location.origin.startsWith("http")) return;
      localStorage.setItem("pi-enter-send-mode", "enter");
      localStorage.setItem("pi-locale", "en");
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
    const steerPrompt = `${STEER_MARKER}: $alpha before $beta and $alpha again queued`;
    const followUpPrompt = `${FOLLOW_UP_MARKER}: $beta before $alpha queued`;
    const normalMultiPrompt = `${NORMAL_MULTI_MARKER}: use $beta, $alpha and $beta. Math check: $x^2$.`;
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
    const initialProviderMessages = targetRequest.payload.messages;
    const initialMainIndex = providerUserMessageIndex(initialProviderMessages, MAIN_MARKER);
    assert.equal(messageText(initialProviderMessages[initialMainIndex]), mainPrompt,
      "provider raw user content must stay exact; skill bodies belong in independent following context messages");
    assert.deepEqual(skillContextMessagesAfter(initialProviderMessages, initialMainIndex).map(messageText),
      [contextWrapper(expectedSkillMetadata(agentDir, "beta"))],
      "only the live beta reference should project after the main raw user message");
    const firstProviderText = providerText(targetRequest.payload);
    assert.ok(!firstProviderText.includes(STEER_MARKER), "future steering input must not leak into the main provider snapshot");
    assert.ok(!firstProviderText.includes(FOLLOW_UP_MARKER), "future follow-up input must not leak into the main provider snapshot");
    assert.ok(!firstProviderText.includes(ALPHA_BODY), "future alpha skill context must not be projected before its originating queued message");
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

    const steerResponse = waitForQueuedPost("steer");
    await textarea.fill(steerPrompt);
    await textarea.press("Enter");
    const steerResult = await steerResponse;
    assert.equal(steerResult.status(), 200, "steering input should be accepted by the real Web API");

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
    const normalResponse = observedWait(page.waitForResponse((response) => {
      try {
        const body = response.request().postDataJSON();
        return response.request().method() === "POST" && response.url().includes(agentPath)
          && body?.type === "prompt" && body?.message === normalMultiPrompt;
      } catch { return false; }
    }));
    const imageFixturePage = await context.newPage();
    let imageFixtureBytes;
    try {
      await imageFixturePage.setContent(`<!doctype html><style>
        html, body { margin: 0; padding: 0; }
        #inline-smoke-image { width: 96px; height: 64px; display: grid; place-items: center; background: linear-gradient(135deg, #1d4ed8, #9333ea); color: white; font: 700 20px sans-serif; }
      </style><div id="inline-smoke-image">PI WEB</div>`);
      imageFixtureBytes = await imageFixturePage.locator("#inline-smoke-image").screenshot({ type: "png" });
    } finally {
      await imageFixturePage.close();
    }
    assert.ok(Buffer.isBuffer(imageFixtureBytes) && imageFixtureBytes.length > 100, "Playwright screenshot fixture should be a non-empty PNG");
    assert.equal(imageFixtureBytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "image fixture should have the PNG signature");
    assert.equal(imageFixtureBytes.toString("ascii", 12, 16), "IHDR", "image fixture should contain a PNG IHDR chunk");
    const imageFixtureWidth = imageFixtureBytes.readUInt32BE(16);
    const imageFixtureHeight = imageFixtureBytes.readUInt32BE(20);
    assert.deepEqual([imageFixtureWidth, imageFixtureHeight], [96, 64], "image fixture should be a 96x64 screenshot");
    const imageFixturePath = join(runDir, INLINE_IMAGE_NAME);
    writeFileSync(imageFixturePath, imageFixtureBytes);
    inlineImageBase64 = imageFixtureBytes.toString("base64");
    evidence.imageFixture = {
      path: imageFixturePath,
      sha256: createHash("sha256").update(imageFixtureBytes).digest("hex"),
      bytes: imageFixtureBytes.length,
      width: imageFixtureWidth,
      height: imageFixtureHeight,
      generatedBy: "Playwright locator screenshot",
    };

    const imageInput = page.locator('input[type="file"][accept="image/*"]');
    assert.equal(await imageInput.count(), 1, "the real composer image input should remain available");
    await imageInput.setInputFiles({
      name: INLINE_IMAGE_NAME,
      mimeType: "image/png",
      buffer: imageFixtureBytes,
    });
    await waitUntil("composer image preview", async () => await page.locator(".chat-input-shell img[src^='blob:']").count() > 0, 15_000);
    await textarea.fill(normalMultiPrompt);
    await textarea.press("Enter");
    assert.equal((await normalResponse).status(), 200, "ordinary multi-skill input should be accepted");
    await waitUntil("ordinary multi-skill terminal reply", async () => {
      const reached = provider.requests.some(({ payload }) => messageWithMarker(payload, NORMAL_MULTI_MARKER));
      return reached && await page.getByText(FAUX_REPLY, { exact: true }).count() >= 4;
    }, 60_000);

    const normalBubble = page.locator(".markdown-user-message").filter({ hasText: NORMAL_MULTI_MARKER });
    const normalBubbleText = await normalBubble.textContent() ?? "";
    assert.ok(normalBubbleText.includes(NORMAL_MULTI_MARKER) && normalBubbleText.includes("$beta") && normalBubbleText.includes("$alpha"),
      "rendered skill references must retain literal dollars rather than become inline math");
    assert.equal(await normalBubble.locator(".katex").count(), 1, "skill references stay literal while ordinary inline math still renders");

    const rawPromptByMarker = new Map([
      [MAIN_MARKER, mainPrompt],
      [NORMAL_MULTI_MARKER, normalMultiPrompt],
      [STEER_MARKER, steerPrompt],
      [FOLLOW_UP_MARKER, followUpPrompt],
    ]);
    const skillNamesByMarker = new Map([
      [MAIN_MARKER, ["beta"]],
      [NORMAL_MULTI_MARKER, ["beta", "alpha"]],
      [STEER_MARKER, ["alpha", "beta"]],
      [FOLLOW_UP_MARKER, ["beta", "alpha"]],
    ]);
    for (const [marker, rawPrompt] of rawPromptByMarker) {
      const apiMatches = evidence.apiCommands.filter(({ body }) => body.message?.includes(marker));
      assert.equal(apiMatches.length, 1, `${marker} should have one original browser API command`);
      assert.equal(apiMatches[0].body.message, rawPrompt, `${marker} Web API command should preserve the exact raw user text`);

      const bubble = page.locator(".markdown-user-message").filter({ hasText: marker }).last();
      const visibleText = await bubble.textContent() ?? "";
      for (const body of [ALPHA_BODY, BETA_BODY, GAMMA_BODY]) {
        assert.ok(!visibleText.includes(body), `${marker} default user bubble must not reveal a skill body`);
      }
      const metadataPanel = page.locator('[data-skill-context="metadata"]').filter({ hasText: marker });
      assert.equal(await metadataPanel.count(), 1, `${marker} UI should recover its compact metadata reference block`);
      const compactText = await metadataPanel.textContent() ?? "";
      for (const name of skillNamesByMarker.get(marker)) {
        assert.ok(compactText.includes(`$${name}`), `${marker} compact references should show $${name}`);
      }
    }

    const providerRecordByMarker = new Map();
    for (const record of provider.requests) {
      const messages = record.payload.messages;
      for (const [marker, rawPrompt] of rawPromptByMarker) {
        if (!messages.some((message) => message?.role === "user" && messageText(message).includes(marker))) continue;
        const userIndex = providerUserMessageIndex(messages, marker);
        const userMessage = messages[userIndex];
        assert.equal(messageText(userMessage), rawPrompt,
          `${marker} provider user message must remain raw; skill instructions belong in following independent context messages`);
        const expectedContexts = skillNamesByMarker.get(marker)
          .map((name) => contextWrapper(expectedSkillMetadata(agentDir, name)));
        const actualContexts = skillContextMessagesAfter(messages, userIndex);
        assert.deepEqual(actualContexts.map(messageText), expectedContexts,
          `${marker} should be followed immediately by one full skill context message per referenced skill, in first-reference order`);
        assert.ok(actualContexts.every((message) => message.role === "user"),
          `${marker} skill contexts must use the SDK's provider user-message serialization`);
        for (const name of skillNamesByMarker.get(marker)) {
          const body = expectedSkillMetadata(agentDir, name).body;
          assert.equal(count(actualContexts.map(messageText).join("\n"), body), 1,
            `${marker} should project ${name}'s full body once within its own origin group`);
        }
        if (!providerRecordByMarker.has(marker)) providerRecordByMarker.set(marker, record);
      }
    }
    assert.deepEqual([...providerRecordByMarker.keys()].sort(), [...rawPromptByMarker.keys()].sort(),
      "each main/steer/follow-up/ordinary prompt must reach the installed SDK provider");
    const normalApiCommand = evidence.apiCommands.find(({ body }) => body.message === normalMultiPrompt);
    assert.deepEqual(normalApiCommand?.body.images?.map(({ data, mimeType }) => ({ data, mimeType })),
      [{ data: inlineImageBase64, mimeType: "image/png" }],
      "the real Web API must retain the attached image alongside the exact raw text");
    const normalProviderRecord = providerRecordByMarker.get(NORMAL_MULTI_MARKER);
    assert.ok(JSON.stringify(normalProviderRecord?.payload.messages).includes(inlineImageBase64),
      "the installed SDK provider request must receive the attached image payload");
    assert.ok(provider.failures.length === 0, `fake provider errors: ${provider.failures.join("; ")}`);

    const sessionResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}?deferThinking=1&deferMedia=1`);
    const sessionBody = await sessionResponse.json();
    assert.equal(sessionResponse.status, 200, "the final SDK session transcript should be readable through the Web API");
    const transcript = JSON.stringify(sessionBody.context?.messages ?? []);
    for (const marker of [MAIN_MARKER, NORMAL_MULTI_MARKER, STEER_MARKER, FOLLOW_UP_MARKER, FAUX_REPLY]) {
      assert.ok(transcript.includes(marker), `terminal transcript should contain ${marker}`);
    }

    const sessionsRoot = `${resolve(join(agentDir, "sessions"))}${sep}`;
    const persistedSessionPath = resolve(sessionBody.filePath ?? "");
    assert.ok(persistedSessionPath.startsWith(sessionsRoot), "session detail should point to this smoke's private persisted session file");
    const persistedEntries = readFileSync(persistedSessionPath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => safeJson(line, "persisted SDK session entry"));
    const persistedUserEntries = persistedEntries
      .filter((entry) => entry?.type === "message" && entry.message?.role === "user");
    const persistedEntryByMarker = new Map();
    for (const [marker, rawPrompt] of rawPromptByMarker) {
      const matches = persistedUserEntries.filter((entry) => messageText(entry.message).includes(marker));
      assert.equal(matches.length, 1, `${marker} should persist as exactly one user message`);
      const entry = matches[0];
      assert.equal(messageText(entry.message), rawPrompt, `${marker} persisted user content must remain the exact raw text`);
      const inlineContext = entry.message.piWeb?.inlineSkillContext;
      assert.equal(inlineContext?.version, 1, `${marker} persisted message should carry inline-skill context version 1`);
      assert.equal(typeof inlineContext?.requestId, "string", `${marker} persisted inline-skill context should have a requestId`);
      assert.ok(inlineContext.requestId.trim(), `${marker} persisted inline-skill context requestId should not be empty`);
      const expectedSkills = skillNamesByMarker.get(marker).map((name) => expectedSkillMetadata(agentDir, name));
      assert.deepEqual(inlineContext.skills?.map(({ name, filePath, baseDir, body }) => ({ name, filePath, baseDir, body })),
        expectedSkills, `${marker} persisted context metadata should contain the selected full skill snapshots in reference order`);
      persistedEntryByMarker.set(marker, entry);
    }
    const normalPersistedMessage = persistedEntryByMarker.get(NORMAL_MULTI_MARKER).message;
    assert.ok(JSON.stringify(normalPersistedMessage.content).includes(inlineImageBase64),
      "the persisted user message should retain its actual image block alongside the exact raw text");
    evidence.persistedSessionFile = persistedSessionPath;
    evidence.persistedRawUserMessageCount = persistedUserEntries.length;
    const mainProviderRecord = providerRecordByMarker.get(MAIN_MARKER);
    const mainProviderMessage = mainProviderRecord.payload.messages[providerUserMessageIndex(mainProviderRecord.payload.messages, MAIN_MARKER)];
    assert.equal(messageText(mainProviderMessage), mainPrompt,
      "the original main user content must contain every literal unchanged, with no skill wrapper appended");
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
    ]) assert.ok(messageText(mainProviderMessage).includes(literal), `original literal should remain in the raw provider user message: ${JSON.stringify(literal)}`);

    const normalContextPanel = page.locator('[data-skill-context="metadata"]').filter({ hasText: NORMAL_MULTI_MARKER }).last();
    const showSkillButton = normalContextPanel.locator('button[aria-expanded="false"]:not([aria-haspopup])');
    assert.equal(await showSkillButton.getAttribute("aria-expanded"), "false", "new skill metadata should start collapsed");
    await page.screenshot({ path: join(runDir, "inline-skill-metadata-compact.png"), fullPage: true });
    await showSkillButton.click();
    assert.equal(await normalContextPanel.locator('button[aria-expanded="true"]:not([aria-haspopup])').count(), 1, "opt-in button should expose its expanded state");
    const expandedContextText = await normalContextPanel.textContent() ?? "";
    const normalizedExpandedContextText = expandedContextText.replace(/\s+/g, "");
    for (const name of skillNamesByMarker.get(NORMAL_MULTI_MARKER)) {
      const skill = expectedSkillMetadata(agentDir, name);
      assert.ok(expandedContextText.includes(skill.filePath), `opt-in disclosure should show ${name}'s exact loaded path`);
      assert.ok(normalizedExpandedContextText.includes(skill.body.replace(/\s+/g, "")),
        `opt-in disclosure should show ${name}'s full snapshotted body`);
    }
    assert.ok(expandedContextText.indexOf(expectedSkillMetadata(agentDir, "beta").filePath)
      < expandedContextText.indexOf(expectedSkillMetadata(agentDir, "alpha").filePath),
    "opt-in skill metadata should retain first-reference order");
    await page.screenshot({ path: join(runDir, "inline-skill-metadata-expanded.png"), fullPage: true });
    await normalContextPanel.locator('button[aria-expanded="true"]:not([aria-haspopup])').click();
    assert.equal(await normalContextPanel.locator('button[aria-expanded="false"]:not([aria-haspopup])').count(), 1);

    await waitUntil("active session URL binding", async () => new URL(page.url()).searchParams.get("session") === sessionId, 15_000);
    await page.reload({ waitUntil: "domcontentloaded" });
    const refreshedContextPanel = page.locator('[data-skill-context="metadata"]').filter({ hasText: NORMAL_MULTI_MARKER }).last();
    await refreshedContextPanel.waitFor({ state: "visible" });
    const refreshedText = await refreshedContextPanel.textContent() ?? "";
    assert.ok(refreshedText.includes(NORMAL_MULTI_MARKER) && refreshedText.includes("$beta") && refreshedText.includes("$alpha"),
      "browser refresh should recover the raw prompt and compact skill references");
    for (const body of [ALPHA_BODY, BETA_BODY, GAMMA_BODY]) {
      assert.ok(!refreshedText.includes(body), "browser refresh should restore skill disclosures in their compact default state");
    }
    assert.equal(await refreshedContextPanel.locator('button[aria-expanded="false"]:not([aria-haspopup])').count(), 1,
      "refreshed metadata should remain opt-in");
    const refreshedImage = refreshedContextPanel.locator("img");
    await refreshedImage.waitFor({ state: "visible" });
    assert.ok((await refreshedImage.getAttribute("src"))?.includes(inlineImageBase64), "browser refresh should recover the persisted image attachment");
    const refreshedSessionResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(sessionId)}?force=1&deferThinking=1&deferMedia=1`);
    assert.equal(refreshedSessionResponse.status, 200, "forced session refresh should reread persisted user context through the real Web API");
    const refreshedSessionBody = await refreshedSessionResponse.json();
    assert.ok(JSON.stringify(refreshedSessionBody.context?.messages ?? []).includes(NORMAL_MULTI_MARKER),
      "refreshed Web API transcript should contain the compact raw user prompt");
    evidence.browserRefreshStatus = refreshedSessionResponse.status;
    await page.screenshot({ path: join(runDir, "inline-skill-refresh-compact.png"), fullPage: true });

    const normalMessageCard = refreshedContextPanel.locator('xpath=ancestor::div[.//button[@title="Copy message"]][1]');
    await normalMessageCard.hover();
    const copyButton = normalMessageCard.getByTitle("Copy message");
    assert.equal(await copyButton.count(), 1, "the targeted user message should expose its own copy action");
    await copyButton.click();
    await waitUntil("raw user prompt copied without skill bodies", async () => {
      try { return await page.evaluate(() => navigator.clipboard.readText()) === normalMultiPrompt; }
      catch { return false; }
    }, 10_000);
    evidence.copiedUserText = await page.evaluate(() => navigator.clipboard.readText());
    assert.equal(evidence.copiedUserText, normalMultiPrompt, "copy should contain only the original short user text, not skill bodies");

    const editButton = normalMessageCard.getByTitle("Edit from here — branches within this session");
    assert.equal(await editButton.count(), 1, "the target user message should expose its edit action");
    await editButton.click();
    assert.equal(await textarea.inputValue(), normalMultiPrompt, "edit should restore only the original raw user text");
    assert.ok(!(await textarea.inputValue()).includes(ALPHA_BODY), "edit text must not contain skill instructions");
    await waitUntil("edited composer restoring the attached image", async () => {
      try {
        return await page.locator(".chat-input-shell img").evaluateAll((images, base64) =>
          images.some((image) => image.getAttribute("src")?.includes(base64)), inlineImageBase64);
      } catch { return false; }
    }, 15_000);
    const cancelEdit = normalMessageCard.getByTitle("Cancel");
    await cancelEdit.click();
    await textarea.fill("");
    evidence.editedUserText = normalMultiPrompt;

    const legacyResponse = await fetch(`${base}/api/sessions/${encodeURIComponent(LEGACY_SESSION_ID)}?deferThinking=1&deferMedia=1`);
    assert.equal(legacyResponse.status, 200, "seeded legacy history should load through the real session API");
    const legacyBody = await legacyResponse.json();
    const legacyUserMessage = (legacyBody.context?.messages ?? []).find((message) => message.role === "user" && messageText(message).includes(LEGACY_MARKER));
    assert.ok(legacyUserMessage, "legacy session API should expose the appended historical prompt");
    const legacyEntries = readFileSync(legacyFixture.sessionFile, "utf8").split(/\r?\n/).filter(Boolean)
      .map((line) => safeJson(line, "legacy fixture session entry"));
    const legacyEntry = legacyEntries.find((entry) => entry.type === "message" && entry.message?.role === "user");
    assert.equal(legacyEntry?.message?.content, legacyFixture.legacyText, "legacy fixture should retain its historical appended user text");
    assert.equal(legacyEntry?.message?.piWeb?.inlineSkillContext, undefined, "legacy fixture should have no new metadata envelope");
    await page.goto(`${base}/?session=${encodeURIComponent(LEGACY_SESSION_ID)}`, { waitUntil: "domcontentloaded" });
    const legacyPanel = page.locator('[data-skill-context="legacy-appended"]').filter({ hasText: LEGACY_MARKER }).last();
    await legacyPanel.waitFor({ state: "visible" });
    const legacyCompactText = await legacyPanel.textContent() ?? "";
    assert.ok(legacyCompactText.includes(LEGACY_MARKER) && legacyCompactText.includes("$beta") && legacyCompactText.includes("$alpha"),
      "legacy appended history should recover its compact raw prompt and skill names");
    for (const body of [ALPHA_BODY, BETA_BODY]) {
      assert.ok(!legacyCompactText.includes(body), "legacy appended history must not reveal skill bodies by default");
    }
    await page.screenshot({ path: join(runDir, "legacy-skill-history-compact.png"), fullPage: true });
    const legacyShow = legacyPanel.locator('button[aria-expanded="false"]:not([aria-haspopup])');
    assert.equal(await legacyShow.getAttribute("aria-expanded"), "false");
    await legacyShow.click();
    const legacyExpandedText = await legacyPanel.textContent() ?? "";
    const normalizedLegacyExpandedText = legacyExpandedText.replace(/\s+/g, "");
    for (const name of ["beta", "alpha"]) {
      const skill = expectedSkillMetadata(agentDir, name);
      assert.ok(legacyExpandedText.includes(skill.filePath), `legacy opt-in disclosure should show ${name}'s original path`);
      assert.ok(normalizedLegacyExpandedText.includes(skill.body.replace(/\s+/g, "")),
        `legacy opt-in disclosure should show ${name}'s full appended body`);
    }
    await page.screenshot({ path: join(runDir, "legacy-skill-history-expanded.png"), fullPage: true });
    await legacyPanel.locator('button[aria-expanded="true"]:not([aria-haspopup])').click();
    assert.deepEqual(evidence.browserErrors, [], `browser errors: ${evidence.browserErrors.join("; ")}`);

    await page.screenshot({ path: join(runDir, "terminal.png"), fullPage: true });
    evidence.status = "PASS";
    evidence.providerRequestCount = provider.requests.length;
    evidence.apiPromptCommands = evidence.apiCommands;
    evidence.transcriptStatus = sessionResponse.status;
    evidence.completedAt = new Date().toISOString();
    console.log(`PASS: browser completion, raw persistence, independent SDK skill contexts, queued association, compact/opt-in UI, refresh, copy/edit, images and legacy history (${provider.requests.length} fake-provider request(s))`);
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
