import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The dev launcher owns these settings. Inheriting them makes supposedly empty
// temp projects live below a trusted checkout, preloads observers into fixtures,
// and changes the CLI lock location. Test-specific env remains caller-owned.
export function standaloneTestEnvironment(source = process.env) {
  const env = { ...source };
  for (const key of ["TMPDIR", "TMP", "TEMP", "XDG_STATE_HOME", "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "PI_WEB_FOLLOW_MANAGED_PI", "PI_WEB_REQUEST_DIAGNOSTICS"]) {
    delete env[key];
  }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, [
    "--experimental-strip-types", "--test", ...process.argv.slice(2),
    "app/**/*.test.mjs", "components/**/*.test.mjs", "hooks/**/*.test.mjs", "lib/**/*.test.mjs", "public/**/*.test.mjs",
  ], { cwd: fileURLToPath(new URL("../", import.meta.url)), env: standaloneTestEnvironment(), stdio: "inherit" });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => child.kill(signal));
  }
  child.once("error", error => { console.error(error.message); process.exitCode = 1; });
  child.once("exit", (code, signal) => { process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1); });
}
