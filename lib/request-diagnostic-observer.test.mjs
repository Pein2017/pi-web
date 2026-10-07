import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';
const jiti = createJiti(import.meta.url);
const { installRequestDiagnostics } = await jiti.import('./request-diagnostic-observer.ts');
const { RequestDiagnostics, BoundedDiagnosticSink, OBSERVATION_CHANNEL } = await jiti.import('./request-diagnostics.ts');
const model = { provider: 'openai', api: 'openai-responses', id: 'm' };
function bus() { const listeners = new Set(); return { on(channel, listener) { assert.equal(channel, OBSERVATION_CHANNEL); listeners.add(listener); return () => listeners.delete(listener); }, emit(channel, data) { for (const f of listeners) { try { f(data); } catch {} } }, listeners }; }
function fixture(fn, id = 's') {
  const lines = []; const sink = new BoundedDiagnosticSink(async line => { lines.push(JSON.parse(line)); });
  const host = new RequestDiagnostics(sink); const events = bus();
  const session = { sessionId: id, agent: { streamFunction: fn }, modelRuntime: { getRegisteredNativeProvider() {}, getRegisteredProviderConfig() {} } };
  const dispose = installRequestDiagnostics(session, events, host);
  return { session, lines, sink, host, events, dispose };
}
const completed = () => { const stream = new AssistantMessageEventStream(); stream.push({ type: 'done', reason: 'stop', message: { stopReason: 'stop' } }); stream.end(); return stream; };

test('unsupported adapters and supplied custom fetch delegate exact original options/context/stream', async () => {
  let passed; const stream = completed(); const f = fixture((...args) => { passed = args; return stream; });
  const context = { messages: [] }; const options = { fetch() { throw Error('must not call'); }, signal: new AbortController().signal };
  assert.equal(f.session.agent.streamFunction(model, context, options), stream);
  assert.equal(passed[2], options); assert.equal(passed[1], context);
  for (const api of ['google-generative-ai', 'google-vertex']) {
    const opts = { onPayload() {} }; f.session.agent.streamFunction({ ...model, api }, context, opts); assert.equal(passed[2], opts); assert.equal(passed[2].fetch, undefined);
  }
  await f.sink.idle(); assert.equal(f.lines.filter(x => x.phase === 'dispatch').length, 0);
  f.dispose(); assert.equal(f.events.listeners.size, 0);
});

test('actual-fetch IDs survive captured warming/retries; unknown terminal never joins latest attempt', async () => {
  const originalFetch = globalThis.fetch; const response = new Response('untouched'); let captured; let forwarded;
  globalThis.fetch = (...args) => { forwarded = args; return Promise.resolve(response); };
  try {
    const f = fixture((_m, _c, options) => { captured = options; return completed(); });
    f.session.agent.streamFunction(model, { messages: [] }, {});
    const init = { body: '{"input":"sentinel"}', signal: new AbortController().signal };
    assert.equal(await captured.fetch('http://localhost/', init), response);
    assert.equal(forwarded[1], init); assert.equal(response.bodyUsed, false);
    await captured.fetch('http://localhost/', init); // same captured callback, as warming or retry
    await captured.onProviderStreamEvent({ type: 'response.completed', response: { id: 'r', usage: { input_tokens_details: { cached_tokens: 0 } } } }, model);
    await f.sink.idle();
    const dispatch = f.lines.filter(x => x.phase === 'dispatch'); assert.equal(dispatch.length, 2);
    assert.notEqual(dispatch[0].attemptId, dispatch[1].attemptId);
    const terminal = f.lines.findLast(x => x.phase === 'terminal');
    assert.equal(terminal.attribution, 'unknown'); assert.equal(terminal.attemptId, 'unknown'); assert.equal(terminal.usage.cachedTokensState, 'zero');
    f.dispose(); const length = f.lines.length;
    await captured.fetch('http://localhost/', init);
    await captured.onProviderStreamEvent({ type: 'response.completed' }, model);
    await f.sink.idle(); assert.equal(f.lines.length, length);
  } finally { globalThis.fetch = originalFetch; }
});

test('abort signal and rejection identity survive observation; arbitrary transport error text is excluded', async () => {
  const originalFetch = globalThis.fetch; const error = new Error('PRIVATE_SENTINEL'); let receivedSignal;
  globalThis.fetch = async (_input, init) => { receivedSignal = init.signal; throw error; };
  try {
    const pending = new AssistantMessageEventStream();
    let captured; const f = fixture((_m, _c, options) => { captured = options; return pending; });
    const controller = new AbortController(); controller.abort('PRIVATE_SENTINEL');
    f.session.agent.streamFunction(model, { messages: [] }, { signal: controller.signal });
    assert.equal(captured.signal, controller.signal);
    await assert.rejects(captured.fetch('http://localhost/', { body: '{}', signal: controller.signal }), candidate => candidate === error);
    await f.sink.idle(); assert.equal(receivedSignal, controller.signal);
    assert.ok(f.lines.some(x => x.phase === 'terminal' && x.status === 'aborted' && x.attribution === 'exact'));
    assert.ok(!JSON.stringify(f.lines).includes('PRIVATE_SENTINEL')); f.dispose();
    pending.push({ type: 'error', reason: 'aborted', error: { stopReason: 'aborted' } }); pending.end();
  } finally { globalThis.fetch = originalFetch; }
});

test('replacement and session-slot eviction remove listeners and restore only the owned wrapper', () => {
  const f = fixture(() => completed());
  const old = f.session.agent.streamFunction;
  const replacementDispose = installRequestDiagnostics(f.session, f.events, f.host);
  assert.equal(f.events.listeners.size, 1);
  f.dispose(); assert.equal(f.events.listeners.size, 1, 'old disposal cannot unregister replacement');
  assert.notEqual(f.session.agent.streamFunction, old);
  for (let i = 0; i < 65; i++) f.host.attach(`other-${i}`);
  assert.equal(f.events.listeners.size, 0, 'eviction releases the observer, not merely its tracking map');
  replacementDispose();
});

test('unmaterialized/oversized bodies and no-fetch transport are explicitly unobserved; no forced transport', async () => {
  const originalFetch = globalThis.fetch; const inputs = []; globalThis.fetch = async (...args) => { inputs.push(args); return new Response('untouched'); };
  try {
    let captured; const f = fixture((_m, _c, options) => { captured = options; return completed(); });
    f.session.agent.streamFunction(model, { messages: [] }, { transport: 'websocket' });
    assert.equal(captured.transport, 'websocket');
    await Promise.resolve(); await f.sink.idle();
    const streamBody = new ReadableStream({ start(controller) { controller.close(); } });
    await captured.fetch('http://localhost/', { body: streamBody, duplex: 'half' });
    await captured.fetch('http://localhost/', { body: 'x'.repeat(8 * 1024 * 1024 + 1) });
    await f.sink.idle();
    assert.equal(inputs[0][1].body, streamBody); assert.equal(streamBody.locked, false);
    assert.deepEqual(f.lines.filter(x => x.phase === 'unobserved').map(x => x.reason), ['transport-unobserved', 'body-unmaterialized', 'body-oversized']);
    assert.equal(f.lines.filter(x => x.phase === 'dispatch').length, 0); f.dispose();
  } finally { globalThis.fetch = originalFetch; }
});

test('public envelopes and usage are frozen/detached; throwing listener cannot mutate raw events', async () => {
  const originalFetch = globalThis.fetch; globalThis.fetch = async () => new Response('untouched');
  try {
    let captured, originalEvent; const f = fixture((_m, _c, options) => { captured = options; return completed(); });
    f.events.on(OBSERVATION_CHANNEL, event => { assert.ok(Object.isFrozen(event)); if (event.usage) { assert.ok(Object.isFrozen(event.usage)); event.usage.cachedTokens = 999; } throw Error('PRIVATE_SENTINEL'); });
    f.session.agent.streamFunction(model, { messages: [] }, { onProviderStreamEvent: event => { originalEvent = event; } });
    await captured.fetch('http://localhost/', { body: '{}' });
    const raw = { type: 'response.completed', response: { usage: { input_tokens_details: { cached_tokens: 5 } } } };
    await captured.onProviderStreamEvent(raw, model);
    assert.equal(originalEvent, raw); assert.equal(raw.response.usage.input_tokens_details.cached_tokens, 5);
    await f.sink.idle(); assert.ok(!JSON.stringify(f.lines).includes('PRIVATE_SENTINEL'));
    f.dispose();
  } finally { globalThis.fetch = originalFetch; }
});
