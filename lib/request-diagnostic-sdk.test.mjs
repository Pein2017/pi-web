import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createJiti } from 'jiti';
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, createEventBus } from '@earendil-works/pi-coding-agent';
const jiti = createJiti(import.meta.url);
const { installRequestDiagnostics } = await jiti.import('./request-diagnostic-observer.ts');
const { RequestDiagnostics, BoundedDiagnosticSink, OBSERVATION_CHANNEL } = await jiti.import('./request-diagnostics.ts');

function response(res, id, cached) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const usage = { input_tokens: 20, output_tokens: 1, ...(cached !== undefined ? { input_tokens_details: { cached_tokens: cached } } : {}) };
  const item = { type: 'message', id: `msg-${id}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Loopback summary.', annotations: [] }] };
  const events = [
    { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'Loopback summary.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage } },
  ];
  res.end(events.map(data => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
}

test('installed SDK session → later payload hook → final fetch → loopback bytes and raw cache states', async t => {
  const root = await mkdtemp(join(tmpdir(), 'pi-request-sdk-'));
  const received = []; let calls = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received.push(Buffer.concat(chunks).toString());
    response(res, `response-${++calls}`, [undefined, 0, 'PRIVATE_SENTINEL'][calls - 1]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const lines = []; const sink = new BoundedDiagnosticSink(async line => { lines.push(JSON.parse(line)); });
  const host = new RequestDiagnostics(sink); const bus = createEventBus(); const final = []; const early = [];
  bus.on(OBSERVATION_CHANNEL, event => { if (event.phase === 'dispatch') final.push(event); });
  const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  runtime.registerProvider('diag-loop', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-PRIVATE_SENTINEL', models: [{ id: 'test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 128 }] });
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, provider: { maxRetries: 0 } } });
  const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime, settingsManager: settings,
    resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [pi => { pi.on('before_provider_request', event => { early.push(JSON.stringify(event.payload)); return { ...event.payload, late_marker: 'PRIVATE_SENTINEL_LATE' }; }); }],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model: runtime.getModel('diag-loop', 'test'), tools: [], thinkingLevel: 'off' });
  const dispose = installRequestDiagnostics(session, bus, host);
  t.after(() => { dispose(); session.dispose(); });
  await session.bindExtensions({});
  for (let i = 0; i < 3; i++) await session.prompt(`PRIVATE_SENTINEL ${i}`);
  await sink.idle();
  assert.equal(calls, 3); assert.equal(final.length, 3); assert.equal(early.length, 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(final[i].body, received[i]);
    assert.equal(JSON.parse(received[i]).late_marker, 'PRIVATE_SENTINEL_LATE');
    assert.notEqual(host.fingerprint(early[i]), host.fingerprint(final[i].body), 'nearest wrong early-hook fingerprint must differ');
    assert.equal(lines.filter(x => x.phase === 'dispatch')[i].body.hmac, host.fingerprint(received[i]));
  }
  assert.deepEqual(lines.filter(x => x.phase === 'terminal').map(x => x.usage.cachedTokensState), ['absent', 'zero', 'invalid']);
  assert.ok(lines.filter(x => x.phase === 'terminal').every(x => x.attribution === 'exact'));
  assert.ok(!JSON.stringify(lines).includes('PRIVATE_SENTINEL'));
  assert.equal(session.messages.filter(x => x.role === 'assistant').length, 3);
});

async function sdkFixture(t, handle, { warming = false, retry = 0 } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'pi-request-overlap-'));
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    await handle(JSON.parse(Buffer.concat(chunks).toString()), res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const lines = []; const sink = new BoundedDiagnosticSink(async line => { lines.push(JSON.parse(line)); });
  const host = new RequestDiagnostics(sink); const sessions = []; const emitted = [];
  t.after(async () => { for (const { session, dispose } of sessions) { dispose(); session.dispose(); } await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  async function make() {
    const bus = createEventBus(); bus.on(OBSERVATION_CHANNEL, event => emitted.push(event));
    const runtime = await ModelRuntime.create({ authPath: join(root, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('diag-loop', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-test', models: [{ id: 'test', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 128, ...(warming ? { promptCache: { short: 10.05 } } : {}) }] });
    let decisions = 0;
    const services = await createAgentSessionServices({ cwd: root, agentDir: root, modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 }, retry: { enabled: false, provider: { maxRetries: retry } }, ...(warming ? { cacheWarming: 'idle' } : {}) }),
      resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [pi => { pi.on('cache_warming_decision', () => ({ action: ++decisions === 1 ? 'warm' : 'stop' })); }],
      },
    });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(root), model: runtime.getModel('diag-loop', 'test'), tools: [], thinkingLevel: 'off' });
    const dispose = installRequestDiagnostics(session, bus, host); sessions.push({ session, dispose }); await session.bindExtensions({}); return session;
  }
  return { make, host, lines, sink, emitted };
}

test('installed SDK interleaved sessions and HTTP retry have isolated IDs; retry usage is unknown, never last-attempt', async t => {
  let calls = 0; let failed = false;
  const f = await sdkFixture(t, async (body, res) => {
    calls++;
    if (!failed) { failed = true; res.writeHead(429, { 'content-type': 'application/json', 'retry-after-ms': '1' }); res.end('{"error":{"message":"PRIVATE_SENTINEL"}}'); return; }
    await new Promise(resolve => setTimeout(resolve, body.prompt_cache_key ? 15 : 1));
    response(res, `r-${calls}`, 2);
  }, { retry: 1 });
  const a = await f.make(); const b = await f.make();
  await Promise.all([a.prompt('one'), b.prompt('two')]); await f.sink.idle();
  assert.equal(calls, 3);
  const dispatches = f.lines.filter(x => x.phase === 'dispatch');
  assert.equal(new Set(dispatches.map(x => x.attemptId)).size, 3);
  assert.equal(new Set(dispatches.map(x => x.sessionId)).size, 2);
  const completed = f.lines.filter(x => x.phase === 'terminal' && x.status === 'completed');
  assert.deepEqual(completed.map(x => x.attribution).sort(), ['exact', 'unknown']);
  assert.equal(completed.find(x => x.attribution === 'unknown').attemptId, 'unknown');
  assert.ok(!JSON.stringify(f.lines).includes('PRIVATE_SENTINEL'));
});

test('installed SDK warming really reuses captured fetch outside streamFunction; both overlapping terminals are unknown', async t => {
  let calls = 0; let resolveWarm; const warmed = new Promise(resolve => { resolveWarm = resolve; });
  const f = await sdkFixture(t, async (_body, res) => {
    const call = ++calls;
    if (call === 1) await new Promise(resolve => setTimeout(resolve, 150));
    response(res, `warm-${call}`, 0);
    if (call === 2) resolveWarm();
  }, { warming: true });
  const session = await f.make();
  await session.prompt('warm overlap');
  await Promise.race([warmed, new Promise((_, reject) => { const timer = setTimeout(() => reject(Error('warming not observed')), 3000); timer.unref(); })]);
  await new Promise(resolve => setTimeout(resolve, 50)); await f.sink.idle();
  assert.equal(calls, 2, 'one real request and one actual SDK warm, no extra request');
  const dispatches = f.lines.filter(x => x.phase === 'dispatch');
  assert.equal(dispatches.length, 2); assert.notEqual(dispatches[0].attemptId, dispatches[1].attemptId);
  const terminals = f.lines.filter(x => x.phase === 'terminal');
  assert.equal(terminals.length, 2); assert.ok(terminals.every(x => x.attribution === 'unknown'));
  assert.ok(session.sessionManager.getEntries().some(x => x.type === 'usage' && x.kind === 'cache_warm'));
});

test('installed SDK native compaction and branch-summary reuse streamFunction without being labeled ordinary', async t => {
  let calls = 0;
  const f = await sdkFixture(t, async (_body, res) => { assert.ok(++calls <= 8, 'bounded local calls'); response(res, `native-${calls}`, 0); });
  const compact = await f.make();
  await compact.prompt('history for native compaction');
  const result = await compact.compact();
  assert.match(result.summary, /Loopback summary/);
  assert.ok(compact.sessionManager.getEntries().some(x => x.type === 'compaction'));
  const branch = await f.make();
  await branch.prompt('first branch');
  const target = branch.sessionManager.getEntries().find(x => x.type === 'message' && x.message.role === 'user').id;
  await branch.prompt('second branch');
  await branch.navigateTree(target, { summarize: true });
  await f.sink.idle();
  assert.ok(branch.sessionManager.getEntries().some(x => x.type === 'branch_summary'));
  assert.equal(calls, 5);
  assert.equal(f.lines.filter(x => x.phase === 'dispatch').length, calls);
  assert.ok(f.lines.filter(x => x.phase === 'dispatch').every(x => x.kind === 'unknown'));
});
