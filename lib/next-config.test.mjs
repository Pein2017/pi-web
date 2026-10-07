import assert from "node:assert/strict";
import path from "node:path";
import { realpathSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function sizeLimitToBytes(value) {
  if (typeof value === "number") return value;
  const match = /^(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)$/i.exec(value.trim());
  assert.ok(match, `unparseable SizeLimit: ${value}`);
  const units = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 };
  return Number(match[1]) * units[match[2].toLowerCase()];
}

test("scopes tracing and Turbopack to the common root required by the managed SDK link", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });
  const commonRoot = path.resolve(projectRoot, "../..");
  assert.equal(config.outputFileTracingRoot, commonRoot);
  assert.equal(config.turbopack.root, commonRoot);
  for (const requiredPath of [projectRoot, realpathSync(path.join(projectRoot, "node_modules/@earendil-works/pi-coding-agent"))]) {
    const relative = path.relative(commonRoot, requiredPath);
    assert.ok(!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`), `${requiredPath} must be inside the resolver root`);
  }
});

test("raises the proxy body buffer above the upload route's 100 MB request cap", async () => {
  const config = await createJiti(import.meta.url).import("../next.config.ts", { default: true });

  assert.ok(sizeLimitToBytes(config.experimental.proxyClientMaxBodySize) > 100 * 1024 * 1024);
});
