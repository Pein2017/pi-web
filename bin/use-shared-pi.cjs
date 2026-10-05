#!/usr/bin/env node
// Bind this local Web checkout to the official managed Pi selected by its CLI.
const fs = require('node:fs');
const path = require('node:path');

const webRoot = path.resolve(__dirname, '..');
const agentRoot = process.env.PI_CODING_AGENT_DIR;
if (!agentRoot || !path.isAbsolute(agentRoot)) {
  throw new Error('Set PI_CODING_AGENT_DIR to the shared Pi profile before starting Web.');
}
const installRoot = path.join(agentRoot, 'install');
const marker = JSON.parse(fs.readFileSync(path.join(installRoot, 'managed-install.json'), 'utf8'));
if (marker.kind !== 'pi-managed-install' || marker.schemaVersion !== 1 || marker.layout !== 'releases-v1') {
  throw new Error('The shared Pi profile does not contain an official managed installation.');
}
const version = fs.readFileSync(path.join(installRoot, 'current-version'), 'utf8').trim();
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('Invalid managed Pi current-version.');
}
const scope = path.join(installRoot, 'releases', version, 'node_modules', '@earendil-works');
const packages = ['pi-coding-agent', 'pi-agent-core', 'pi-ai', 'pi-tui'];
for (const name of packages) {
  const manifest = JSON.parse(fs.readFileSync(path.join(scope, name, 'package.json'), 'utf8'));
  if (manifest.name !== `@earendil-works/${name}` || manifest.version !== version) {
    throw new Error(`Managed Pi has inconsistent package identity/version: ${name}.`);
  }
}
const mode = process.argv[2] ?? '--check';
if (!['--check', '--activate'].includes(mode) || process.argv.length > 3) {
  throw new Error('Usage: node bin/use-shared-pi.cjs --check|--activate');
}
if (mode === '--activate') {
  const destination = path.join(webRoot, 'node_modules', '@earendil-works');
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (!existing || fs.realpathSync(destination) !== fs.realpathSync(scope)) {
    const recovery = path.join(webRoot, '.local', 'recovery', 'shared-pi-runtime');
    fs.mkdirSync(recovery, { recursive: true, mode: 0o700 });
    const stamp = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
    const receipt = { time: new Date().toISOString(), version, scope, previous: null, backup: null };
    const temporary = `${destination}.next-${process.pid}`;
    fs.symlinkSync(scope, temporary, 'dir');
    try {
      if (existing && !existing.isSymbolicLink()) {
        receipt.backup = path.join(recovery, `earendil-works-${stamp}`);
        fs.renameSync(destination, receipt.backup);
      } else if (existing) {
        receipt.previous = fs.readlinkSync(destination);
      }
      try {
        fs.renameSync(temporary, destination);
      } catch (error) {
        if (receipt.backup) fs.renameSync(receipt.backup, destination);
        throw error;
      }
      fs.writeFileSync(path.join(recovery, `${stamp}.json`), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    } finally {
      if (fs.lstatSync(temporary, { throwIfNoEntry: false })) fs.unlinkSync(temporary);
    }
  }
}
console.log(JSON.stringify({ mode, version, scope }));
