import assert from "node:assert/strict";
import test from "node:test";
import { standaloneTestEnvironment } from "../bin/test-web.mjs";

test("standalone tests do not inherit dev fixture roots, observer preloads or update flags", () => {
  const keys = ["TMPDIR", "TMP", "TEMP", "XDG_STATE_HOME", "NODE_OPTIONS", "NODE_USE_ENV_PROXY", "PI_WEB_FOLLOW_MANAGED_PI", "PI_WEB_REQUEST_DIAGNOSTICS"];
  const source = Object.fromEntries(keys.map(key => [key, "dev-only"]));
  const actual = standaloneTestEnvironment({ ...source, PATH: "test-path", CUSTOM_FIXTURE_OPTION: "preserved" });
  for (const key of keys) assert.equal(Object.hasOwn(actual, key), false, key);
  assert.deepEqual(actual, { PATH: "test-path", CUSTOM_FIXTURE_OPTION: "preserved" });
  assert.deepEqual(source, Object.fromEntries(keys.map(key => [key, "dev-only"])), "caller env must remain unchanged");
});
