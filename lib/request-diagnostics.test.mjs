import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, readdir, stat, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { RequestDiagnostics, BoundedDiagnosticSink, rawResponseUsage, OBSERVATION_CHANNEL, privateRotatingWriter, hostRequestDiagnostics } = await jiti.import('./request-diagnostics.ts');

const base = { version: 1, sessionId: 's', operationId: 'o', attemptId: 'a', provider: 'p', api: 'openai-responses', model: 'm', kind: 'unknown' };
const dispatch = (extra = {}) => Object.freeze({ ...base, phase: 'dispatch', coverage: 'http-final', body: '{"input":[{"content":"PRIVATE_SENTINEL"}]}', ...extra });
const capture = () => { const lines = []; const sink = new BoundedDiagnosticSink(async line => { lines.push(JSON.parse(line)); }); return { lines, sink, host: new RequestDiagnostics(sink) }; };

test('raw cache presence distinguishes absent, zero, valid and invalid without source references', () => {
  assert.deepEqual(rawResponseUsage({}), { cachedTokensState: 'absent' });
  for (const [value, state] of [[0, 'zero'], [4, 'value'], [-1, 'invalid'], ['PRIVATE_SENTINEL', 'invalid'], [NaN, 'invalid']]) {
    const source = { input_tokens: 8, output_tokens: 1, input_tokens_details: { cached_tokens: value } };
    const usage = rawResponseUsage(source);
    assert.equal(usage.cachedTokensState, state);
    assert.equal(usage.cachedTokens, state === 'zero' || state === 'value' ? value : undefined);
    assert.ok(Object.isFrozen(usage));
    assert.ok(!JSON.stringify(usage).includes('PRIVATE_SENTINEL'));
  }
});

test('host fingerprints body and ALL untrusted metadata; rejects unknown session and invalid envelopes', async () => {
  const { host, sink, lines } = capture();
  const session = host.attach('s');
  session.observe(dispatch({ provider: 'PRIVATE_SENTINEL', model: 'PRIVATE_SENTINEL', responseId: 'PRIVATE_SENTINEL' }));
  session.observe(dispatch({ sessionId: 'other' }));
  session.observe(dispatch({ version: 2 }));
  session.observe({ ...base, phase: 'unobserved', reason: 'PRIVATE_SENTINEL' });
  await sink.idle();
  assert.equal(lines.filter(x => x.phase === 'dispatch').length, 1);
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_SENTINEL'));
  assert.equal(lines[0].body.bytes, Buffer.byteLength(dispatch().body));
  assert.match(lines[0].body.hmac, /^[a-f0-9]{64}$/);
  assert.equal(host.stats().rejected, 3);
  session.dispose();
});

test('sink includes inflight in backlog caps and never awaits stalled IO on observation', async () => {
  let release; const blocked = new Promise(resolve => { release = resolve; });
  const sink = new BoundedDiagnosticSink(() => blocked);
  for (let i = 0; i < 300; i++) sink.enqueue({ phase: 'test', text: 'x'.repeat(4000) });
  assert.ok(sink.stats().pendingRecords <= 128);
  assert.ok(sink.stats().pendingBytes <= 256 * 1024);
  assert.ok(sink.stats().dropped > 0);
  sink.enqueue({ text: 'x'.repeat(16384) });
  assert.ok(sink.stats().oversized > 0);
  release(); await sink.idle();
});

test('session replacement/disposal invalidates captured observers; tracking is finite', async () => {
  const { host, sink, lines } = capture();
  const old = host.attach('s'); const current = host.attach('s');
  old.observe(dispatch()); old.dispose(); current.observe(dispatch());
  for (let i = 0; i < 150; i++) current.observe(dispatch({ attemptId: `a${i}` }));
  assert.ok(host.stats().attempts <= 128);
  current.dispose(); current.observe(dispatch());
  for (let i = 0; i < 80; i++) host.attach(`s${i}`);
  assert.ok(host.stats().sessions <= 64);
  assert.ok(host.stats().evicted > 0);
  await sink.idle();
  assert.equal(lines.filter(x => x.phase === 'dispatch' && x.attemptId === 'a').length, 0); // raw IDs never persisted
  assert.equal(OBSERVATION_CHANNEL, 'pi:request-observation:v1');
});

test('default-off requires the exact host switch; malformed usage and arbitrary error text never reach records', async () => {
  const previous = process.env.PI_WEB_REQUEST_DIAGNOSTICS;
  try { delete process.env.PI_WEB_REQUEST_DIAGNOSTICS; assert.equal(hostRequestDiagnostics(), undefined); process.env.PI_WEB_REQUEST_DIAGNOSTICS = 'true'; assert.equal(hostRequestDiagnostics(), undefined); }
  finally { if (previous === undefined) delete process.env.PI_WEB_REQUEST_DIAGNOSTICS; else process.env.PI_WEB_REQUEST_DIAGNOSTICS = previous; }
  const { host, sink, lines } = capture(); const session = host.attach('s');
  session.observe(dispatch({ kind: 'compaction' }));
  session.observe({ ...base, phase: 'terminal', kind: 'compaction', status: 'error', usage: { cachedTokensState: 'absent' }, responseId: 'PRIVATE_SENTINEL', error: 'PRIVATE_SENTINEL' });
  session.observe({ ...base, phase: 'terminal', status: 'completed', usage: { cachedTokensState: 'value', cachedTokens: -1 } });
  await sink.idle();
  const terminal = lines.find(x => x.phase === 'terminal'); assert.equal(terminal.attribution, 'exact'); assert.equal(terminal.kind, 'compaction');
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_SENTINEL')); assert.equal(host.stats().rejected, 1);
});

test('private filesystem sink rotates at two 1MiB files, enforces permissions, refuses symlink target', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-diagnostic-sink-')); t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'diagnostics'); const writer = privateRotatingWriter(directory);
  const line = JSON.stringify({ hmac: 'a'.repeat(12000) }) + '\n';
  for (let i = 0; i < 220; i++) await writer(line);
  const files = await readdir(directory); assert.deepEqual(files.sort(), ['requests.jsonl', 'requests.previous.jsonl']);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  for (const name of files) { const info = await stat(join(directory, name)); assert.ok(info.size <= 1024 * 1024); assert.equal(info.mode & 0o777, 0o600); assert.ok((await readFile(join(directory, name), 'utf8')).endsWith('\n')); }
  const target = join(root, 'outside'); await symlink(directory, target);
  await assert.rejects(privateRotatingWriter(target)(line));
});

test('enum-shaped objects and changing accessors cannot smuggle prompt text through allowlisted fields', async () => {
  const { host, sink, lines } = capture(); const session = host.attach('s');
  const impostor = name => ({ toString: () => name, secret: 'PRIVATE_SENTINEL' });
  session.observe(dispatch({ kind: impostor('unknown') }));
  session.observe({ ...base, phase: 'terminal', status: impostor('completed'), usage: { cachedTokensState: 'absent' } });
  session.observe({ ...base, phase: 'terminal', status: 'completed', usage: { cachedTokensState: impostor('absent') } });
  session.observe({ ...dispatch(), get kind() { throw Error('PRIVATE_SENTINEL'); } });
  await sink.idle(); assert.equal(lines.length, 0); assert.equal(host.stats().rejected, 4);
});

test('sink failure remains contained and counters disclose it on subsequent records', async () => {
  let fail = true; const lines = []; const sink = new BoundedDiagnosticSink(async line => { if (fail) throw Error('PRIVATE_SENTINEL'); lines.push(line); });
  sink.enqueue({ phase: 'first' }); await sink.idle(); fail = false; sink.enqueue({ phase: 'next' }); await sink.idle();
  assert.equal(sink.stats().failures, 1); assert.equal(JSON.parse(lines[0]).sink.failures, 1); assert.ok(!lines[0].includes('PRIVATE_SENTINEL'));
});
