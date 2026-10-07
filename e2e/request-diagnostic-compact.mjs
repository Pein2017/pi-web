import assert from 'node:assert/strict';
import test from 'node:test';
import { isDeepStrictEqual } from 'node:util';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from 'jiti';
import { createAgentSessionServices, createAgentSessionFromServices, ModelRuntime, SessionManager, SettingsManager, createEventBus } from '@earendil-works/pi-coding-agent';

// Explicit cross-repository qualification, outside npm test's standalone Web suite.
// No production Web module imports compact. Bind source imports to the actual host SDK.
const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.env.PI_WEB_COMPACT_SOURCE_ROOT) throw new Error('Set PI_WEB_COMPACT_SOURCE_ROOT to the pi-codex-compact source package for test:compact-integration');
const compactRoot = resolve(process.env.PI_WEB_COMPACT_SOURCE_ROOT);
const alias = Object.fromEntries(['pi-ai', 'pi-coding-agent', 'pi-agent-core', 'pi-tui'].map(name => [`@earendil-works/${name}`, fileURLToPath(import.meta.resolve(`@earendil-works/${name}`))]));
const loader = createJiti(import.meta.url, { alias, moduleCache: false });
const { createCodexCompactExtension } = await loader.import(join(compactRoot, 'src/codex-compact.ts'));
const { DEFAULT_CODEX_COMPACT_SETTINGS } = await loader.import(join(compactRoot, 'src/settings.ts'));
const { createRequestObservationSession } = await loader.import(join(compactRoot, 'src/request-observation.ts'));
const { parseCheckpointDetails } = await loader.import(join(compactRoot, 'src/checkpoint.ts'));
const { installRequestDiagnostics } = await loader.import(join(webRoot, 'lib/request-diagnostic-observer.ts'));
const { RequestDiagnostics, BoundedDiagnosticSink, OBSERVATION_CHANNEL } = await loader.import(join(webRoot, 'lib/request-diagnostics.ts'));
const opaque = { type: 'compaction', id: 'cmp_fixture', encrypted_content: 'PRIVATE_OPAQUE_SENTINEL' };
const zeroUsage = { input: 20, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 21, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

function settingsRuntime(enabled) {
  const state = { kind: 'loaded', path: '/unused-test-settings', document: {}, settings: {
    ...DEFAULT_CODEX_COMPACT_SETTINGS, protocol: 'context-management', requestDiagnostics: enabled,
    maxRetries: 0, notifyOnFallback: false, checkpointRecovery: 'cancel',
  } };
  return { get: () => structuredClone(state), reload: async () => structuredClone(state), update: async () => { throw Error('test does not update settings'); }, flush: async () => {} };
}
function sendEvents(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
  res.end(events.map(data => `data: ${JSON.stringify(data)}\n\n`).join(''));
}
function checkpointContract(details) {
  const contract = { ...details };
  delete contract.checkpointId;
  delete contract.createdAt;
  return contract;
}

test('compact source → installed SDK HTTP → public EventBus → Web sink preserves published/replayed checkpoints off/on/adversarial', async t => {
  for (const name of ['pi-ai', 'pi-coding-agent']) {
    const packageRoot = dirname(dirname(await realpath(alias[`@earendil-works/${name}`])));
    assert.equal(await realpath(join(webRoot, 'node_modules/@earendil-works', name)), packageRoot);
    assert.equal(JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version, '1.0.3');
  }
  const root = await mkdtemp(join(tmpdir(), 'pi-compact-web-join-'));
  const requests = []; let compactions = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString(); requests.push(body);
    if (requests.length > 6) { res.writeHead(500); res.end(); return; }
    const parsed = JSON.parse(body);
    if (parsed.context_management) {
      const cached = ++compactions === 3 ? { input_tokens_details: { cached_tokens: 0 } } : {};
      sendEvents(res, [
        { type: 'response.output_item.done', output_index: 0, item: opaque },
        { type: 'response.completed', response: { id: 'resp_compact', status: 'completed', output: [opaque], usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21, ...cached } } },
      ]);
    } else {
      const item = { type: 'message', id: 'msg_replay', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'replayed', annotations: [] }] };
      sendEvents(res, [
        { type: 'response.output_item.added', output_index: 0, item: { ...item, content: [] } },
        { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'replayed' },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id: 'resp_replay', status: 'completed', output: [item], usage: { input_tokens: 20, output_tokens: 1, total_tokens: 21 } } },
      ]);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const ownedSessions = []; const releases = [];
  t.after(async () => { for (const dispose of releases) dispose(); for (const session of ownedSessions) session.dispose(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const records = []; const sink = new BoundedDiagnosticSink(async line => { records.push(JSON.parse(line)); });
  const host = new RequestDiagnostics(sink);
  const results = []; let rejectedMutations = 0, thrownParticipants = 0, observedBusErrors = 0;
  const originalConsoleError = console.error;
  console.error = (...args) => {
    // The SDK event bus itself logs participant errors. Swallow only this deliberate fixture error,
    // not production observer errors, and assert its count outside the swallowed callback.
    if (args.some(arg => arg instanceof Error && arg.message === 'fixture participant failure')) { observedBusErrors++; return; }
    originalConsoleError(...args);
  };
  t.after(() => { console.error = originalConsoleError; });
  for (const mode of ['off', 'on', 'adversarial']) {
    const enabled = mode !== 'off'; const bus = createEventBus();
    if (mode === 'adversarial') {
      releases.push(bus.on(OBSERVATION_CHANNEL, event => {
        if (event.phase === 'dispatch' && Object.isFrozen(event) && !Reflect.set(event, 'body', 'PRIVATE_MUTATION_SENTINEL')) rejectedMutations++;
        if (event.phase === 'terminal' && Object.isFrozen(event.usage) && !Reflect.set(event.usage, 'cachedTokens', 999)) rejectedMutations++;
      }));
      releases.push(bus.on(OBSERVATION_CHANNEL, () => { thrownParticipants++; throw Error('fixture participant failure'); }));
    }
    const runtime = await ModelRuntime.create({ authPath: join(root, mode, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    runtime.registerProvider('openai', { api: 'openai-responses', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'sk-PRIVATE_CREDENTIAL_SENTINEL', models: [{ id: 'gpt-fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 128 }] });
    const services = await createAgentSessionServices({ cwd: root, agentDir: join(root, mode), modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 0, reserveTokens: 128 }, retry: { enabled: false, provider: { maxRetries: 0 } } }),
      resourceLoaderOptions: { eventBus: bus, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: [createCodexCompactExtension({ settingsRuntime: settingsRuntime(enabled) })],
      },
    });
    const model = runtime.getModel('openai', 'gpt-fixture');
    const sessionDir = join(root, mode, 'sessions'); await mkdir(sessionDir, { recursive: true });
    const manager = SessionManager.create(root, sessionDir);
    manager.appendMessage({ role: 'user', content: 'PRIVATE_OLD_HISTORY_SENTINEL', timestamp: 1 });
    manager.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'ready' }], api: model.api, provider: model.provider, model: model.id, usage: zeroUsage, stopReason: 'stop', timestamp: 2 });
    const open = async manager => {
      const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [], thinkingLevel: 'off' });
      ownedSessions.push(session);
      const dispose = enabled ? installRequestDiagnostics(session, bus, host) : () => {};
      releases.push(dispose); await session.bindExtensions({}); return { session, dispose };
    };
    const { session, dispose } = await open(manager);
    const before = records.length;
    const compacted = await session.compact();
    await sink.idle();
    const details = parseCheckpointDetails(compacted.details);
    assert.ok(details, 'the extension must publish an opaque checkpoint, not fall back to native summary');
    assert.ok(isDeepStrictEqual(details.replacementHistory, [opaque]), 'checkpoint contents match without printing opaque data');
    const path = manager.getSessionFile(); assert.ok(path);
    const journal = await readFile(path, 'utf8');
    assert.ok(!journal.includes('pi:request-observation:v1') && !journal.includes('observerGeneration'), 'diagnostic evidence never enters the journal');
    const compactRecords = records.slice(before).filter(record => record.kind === 'compaction');
    assert.equal(compactRecords.length, enabled ? 2 : 0);
    const request = requests.at(-1);
    if (enabled) {
      const dispatch = compactRecords.find(record => record.phase === 'dispatch');
      const terminal = compactRecords.find(record => record.phase === 'terminal');
      assert.equal(dispatch.body.hmac, host.fingerprint(request));
      assert.equal(dispatch.body.bytes, Buffer.byteLength(request));
      assert.equal(dispatch.coverage, 'http-final');
      assert.equal(terminal.attribution, 'exact'); assert.equal(terminal.attemptId, dispatch.attemptId);
      assert.equal(terminal.usage.cachedTokensState, mode === 'on' ? 'absent' : 'zero');
    }
    dispose(); session.dispose();
    const restored = SessionManager.open(path, sessionDir);
    const stored = restored.getEntries().findLast(entry => entry.type === 'compaction');
    assert.ok(isDeepStrictEqual(parseCheckpointDetails(stored.details), details), 'actual SDK persistence/reload retains checkpoint bytes');
    const reopened = await open(restored);
    await reopened.session.prompt('PRIVATE_NEW_TAIL_SENTINEL');
    await sink.idle();
    const replay = JSON.parse(requests.at(-1));
    assert.equal(replay.input.filter(item => item.type === 'compaction').length, 1);
    assert.ok(isDeepStrictEqual(replay.input.find(item => item.type === 'compaction'), opaque), 'opaque replay item is unchanged');
    assert.ok(!JSON.stringify(replay.input).includes('PRIVATE_OLD_HISTORY_SENTINEL'));
    assert.ok(JSON.stringify(replay.input).includes('PRIVATE_NEW_TAIL_SENTINEL'));
    assert.ok(!JSON.stringify(replay.input).includes('PI_CODEX_REMOTE_CHECKPOINT'));
    assert.equal(reopened.session.getLastAssistantText(), 'replayed');
    results.push({ request, contract: checkpointContract(details), usage: compacted.usage, replayInput: replay.input });
    reopened.dispose(); reopened.session.dispose();
  }
  assert.equal(compactions, 3); assert.equal(requests.length, 6);
  assert.equal(rejectedMutations, 4); assert.equal(thrownParticipants, 4); assert.equal(observedBusErrors, 4);
  for (const result of results.slice(1)) {
    assert.ok(result.request === results[0].request, 'observer off/on/hostile participants preserve final compact bytes');
    assert.ok(isDeepStrictEqual(result.contract, results[0].contract), 'checkpoint contracts unchanged');
    assert.deepEqual(result.usage, results[0].usage);
    assert.ok(isDeepStrictEqual(result.replayInput, results[0].replayInput), 'replay input unchanged');
  }
  assert.equal(host.stats().rejected, 0);
  assert.ok(!JSON.stringify(records).includes('PRIVATE_'));
  const receiptPath = process.env.PI_WEB_REQUEST_DIAGNOSTICS_TEST_RECEIPT;
  if (receiptPath) {
    const dispatch = records.find(record => record.phase === 'dispatch' && record.kind === 'compaction');
    await mkdir(dirname(receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({ sdkVersion: '1.0.3', epoch: host.epoch, bodyHmac: dispatch.body.hmac, bodyBytes: dispatch.body.bytes, loopbackRequests: requests.length, compactRequests: compactions, cacheStates: ['absent', 'zero'], checkpointPublishedReloadedAndReplayed: true, observerOffOnAdversarialEquivalent: true, rejectedMutations, thrownParticipants, rawSecretsPersisted: false }, null, 2) + '\n', { mode: 0o600 });
  }
});

test('compact unobserved reason enum reaches the real Web listener without rejection', async () => {
  const records = []; const sink = new BoundedDiagnosticSink(async line => { records.push(JSON.parse(line)); });
  const host = new RequestDiagnostics(sink); const bus = createEventBus();
  const session = { sessionId: 'compact-reason-session', agent: { streamFunction: () => { throw Error('no model invocation permitted'); } }, modelRuntime: {} };
  const dispose = installRequestDiagnostics(session, bus, host);
  try {
    const context = { sessionId: session.sessionId, provider: 'openai', api: 'openai-responses', model: 'gpt-fixture', httpFinalEligible: true, canCorrelateFetch: true, emit: event => bus.emit(OBSERVATION_CHANNEL, event) };
    const body = createRequestObservationSession(context);
    body.dispatch({}); body.dispatch('x'.repeat(8 * 1024 * 1024 + 1)); body.dispose();
    const transport = createRequestObservationSession(context); transport.noHttpDispatch(); transport.dispose();
    await sink.idle();
    assert.deepEqual(records.map(record => record.reason), ['body-unmaterialized', 'body-oversized', 'transport-unobserved']);
    assert.equal(host.stats().rejected, 0);
  } finally { dispose(); }
});
