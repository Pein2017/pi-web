import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

test("canonical install replaces a retired broken binding; invalid SDK identity retains the binding", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-binding-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const web = join(root, "web");
  const install = join(root, "canonical-install");
  const version = "1.0.3";
  const scope = join(install, "releases", version, "node_modules", "@earendil-works");
  await mkdir(join(web, "bin"), { recursive: true });
  await mkdir(join(web, "node_modules"));
  await mkdir(install);
  await cp(new URL("./use-shared-pi.cjs", import.meta.url), join(web, "bin", "use-shared-pi.cjs"));
  await writeFile(join(install, "managed-install.json"), JSON.stringify({ kind: "pi-managed-install", schemaVersion: 1, layout: "releases-v1" }));
  await writeFile(join(install, "current-version"), version);
  for (const name of ["pi-coding-agent", "pi-agent-core", "pi-ai", "pi-tui"]) {
    await mkdir(join(scope, name), { recursive: true });
    await writeFile(join(scope, name, "package.json"), JSON.stringify({ name: `@earendil-works/${name}`, version }));
  }
  const destination = join(web, "node_modules", "@earendil-works");
  await symlink(join(root, "retired-install", "@earendil-works"), destination);
  const env = { ...process.env, PI_CODING_AGENT_DIR: join(root, "separate-profile"), PI_MANAGED_INSTALL_ROOT: install };
  const run = () => spawnSync(process.execPath, [join(web, "bin", "use-shared-pi.cjs"), "--activate"], { env, encoding: "utf8" });
  const activated = run();
  assert.equal(activated.status, 0, activated.stderr);
  assert.equal(await readlink(destination), scope);
  await writeFile(join(scope, "pi-tui", "package.json"), JSON.stringify({ name: "@earendil-works/pi-tui", version: "99.0.0" }));
  const rejected = run();
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /inconsistent package identity\/version: pi-tui/);
  assert.equal(await readlink(destination), scope);
});
