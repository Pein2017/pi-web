import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import test from "node:test";
import { ESLint } from "eslint";
import ts from "typescript";

const root = fileURLToPath(new URL("../", import.meta.url));

test("lint checks source but excludes private runtime/recovery and source indexes", async () => {
  const eslint = new ESLint({ cwd: root });
  assert.ok(await eslint.calculateConfigForFile("lib/session-stats.ts"));
  for (const path of [".local/recovery/runtime.ts", ".local/tmp/source-copy.ts", ".codegraph/generated.ts", "demo/components/AppShell.tsx"]) {
    assert.equal(await eslint.calculateConfigForFile(path), undefined, path);
  }
});

test("TypeScript discovers source without recursively collecting private snapshots", () => {
  const { config, error } = ts.readConfigFile(fileURLToPath(new URL("../tsconfig.json", import.meta.url)), ts.sys.readFile);
  assert.equal(error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, root);
  assert.deepEqual(parsed.errors, []);
  const paths = parsed.fileNames.map(path => relative(root, path).replaceAll("\\", "/"));
  assert.ok(paths.includes("lib/session-stats.ts"));
  assert.ok(paths.every(path => !path.startsWith(".local/") && !path.startsWith(".codegraph/") && !path.startsWith("demo/")));
});
