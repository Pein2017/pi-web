import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import('./rpc-manager.ts');

test('production RPC shutdown releases observation at closing, before extension shutdown finishes', async () => {
  let release; const waiting = new Promise(resolve => { release = resolve; });
  let cleanups = 0, disposed = 0;
  const inner = { sessionId: 'diagnostic-rpc', isBashRunning: false, agent: { state: {} },
    extensionRunner: { emit: () => waiting }, dispose: () => { disposed++; },
  };
  const wrapper = new AgentSessionWrapper(inner, { disposeRequestDiagnostics: () => { cleanups++; } });
  const shutdown = wrapper.shutdown();
  assert.equal(cleanups, 1); assert.equal(disposed, 0);
  release(); await shutdown; wrapper.destroy(); wrapper.disposeRequestDiagnostics();
  assert.equal(cleanups, 1); assert.equal(disposed, 1);
});

test('production RPC direct destruction isolates throwing cleanup and never repeats it', async () => {
  let cleanups = 0, disposed = 0;
  const inner = { sessionId: 'diagnostic-rpc', isBashRunning: false, agent: { state: {} },
    extensionRunner: {}, dispose: () => { disposed++; },
  };
  const wrapper = new AgentSessionWrapper(inner, { disposeRequestDiagnostics: () => { cleanups++; throw Error('PRIVATE_SENTINEL'); } });
  wrapper.destroy(); wrapper.destroy();
  assert.equal(cleanups, 1); assert.equal(disposed, 1);
});
