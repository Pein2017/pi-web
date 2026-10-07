/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS is also consumed by isolated native Node fixtures. */
// The single process gate survives Next HMR. Production/standalone Web never
// enables the observer; local-dev.sh explicitly selects the managed dev mode.
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

/**
 * @typedef {Object} UpdateOptions
 * @property {string} loadedVersion
 * @property {() => string} readSelectedVersion
 * @property {() => boolean} hasBusyWork
 * @property {() => Promise<void>} shutdownIdleSessions
 * @property {() => void} validate
 * @property {() => void} activate
 * @property {() => void} requestRestart
 * @property {(message: string) => void} log
 */

/** @param {UpdateOptions} options */
function createSharedPiUpdate(options) {
  let draining = false;
  let checking = false;
  let lastNotice = "";
  const notice = (message) => {
    if (lastNotice === message) return;
    lastNotice = message;
    options.log(message);
  };
  return {
    /** @param {Pick<UpdateOptions, "hasBusyWork" | "shutdownIdleSessions">} callbacks */
    configure(callbacks) { Object.assign(options, callbacks); },
    assertAdmission() {
      if (draining) throw new Error("Pi runtime is updating; retry shortly");
    },
    async tick() {
      if (checking || draining) return;
      checking = true;
      try {
        const selected = options.readSelectedVersion();
        if (selected === options.loadedVersion) return;
        if (options.hasBusyWork()) {
          notice(`selected=${selected} loaded=${options.loadedVersion}; waiting for sessions and terminal shells to become idle`);
          return;
        }
        // Validate before disposing idle sessions. No await separates the final
        // busy check from closing admission, so a request cannot slip between.
        options.validate();
        draining = true;
        notice(`selected=${selected} loaded=${options.loadedVersion}; adopting after idle shutdown`);
        await options.shutdownIdleSessions();
        options.activate();
        options.requestRestart();
      } catch (error) {
        draining = false;
        notice(`adoption failed; retained loaded=${options.loadedVersion}: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        checking = false;
      }
    },
  };
}

function assertSharedPiWorkAdmission() {
  globalThis.__piSharedUpdate?.assertAdmission();
}

/** @param {Pick<UpdateOptions, "hasBusyWork" | "shutdownIdleSessions">} callbacks */
function startSharedPiUpdateObserver(callbacks) {
  if (process.env.PI_WEB_FOLLOW_MANAGED_PI !== "1") return;
  if (process.env.NEXT_PRIVATE_WORKER !== "1" || typeof process.send !== "function") {
    throw new Error("Managed Pi adoption requires a Next dev worker");
  }
  if (globalThis.__piSharedUpdate) {
    globalThis.__piSharedUpdate.configure(callbacks);
    return;
  }
  const installRoot = process.env.PI_MANAGED_INSTALL_ROOT;
  if (!installRoot || !path.isAbsolute(installRoot)) throw new Error("Set the canonical PI_MANAGED_INSTALL_ROOT");
  const webRoot = process.cwd();
  const loadedVersion = JSON.parse(fs.readFileSync(path.join(webRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version;
  const bind = (mode) => {
    execFileSync(process.execPath, [path.join(webRoot, "bin/use-shared-pi.cjs"), mode], { env: process.env, stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
  };
  const log = (message) => console.info(`[pi-web:managed-update] ${message}`);
  const coordinator = createSharedPiUpdate({
    ...callbacks, loadedVersion,
    readSelectedVersion: () => fs.readFileSync(path.join(installRoot, "current-version"), "utf8").trim(),
    validate: () => bind("--check"),
    activate: () => bind("--activate"),
    // Next's CLI owns restart and retains its chosen port and tmux process.
    requestRestart: () => process.exit(require("next/dist/server/lib/utils").RESTART_EXIT_CODE),
    log,
  });
  globalThis.__piSharedUpdate = coordinator;
  const timer = setInterval(() => { void coordinator.tick(); }, 2000);
  timer.unref();
  process.once("exit", () => clearInterval(timer));
  log(`observer enabled; loaded=${loadedVersion} install=${installRoot}`);
}

module.exports = { createSharedPiUpdate, assertSharedPiWorkAdmission, startSharedPiUpdateObserver };
