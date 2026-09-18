import 'fake-indexeddb/auto';
import type { OpenMiniManifest } from '@openmini/manifest';
import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  type BridgeResponseEnvelope,
} from '@openmini/shared';
import { describe, expect, it } from 'vitest';
import type { MiniAppSandbox, SandboxStateListener } from '../sandbox/types';
import { createBridgeDispatcher } from './dispatcher';
import { createIndexedDbStorageProvider } from './handlers/indexedDbStorageProvider';
import { createStorageHandlers } from './handlers/storage';

/**
 * Proves storage.* survives a real destroy/recreate cycle at the
 * dispatcher+provider level: two independently-constructed dispatchers (each
 * with their own fake sandbox, port pair, and provider instance pointed at
 * the same IndexedDB database) simulate a Mini App being destroyed and then
 * reloaded. This is the in-process stand-in for the real browser cycle
 * e2e/bridge-storage-persistence.spec.ts exercises end-to-end; jsdom cannot
 * drive a real sandbox to `running` (see docs/security/sandbox.md), so this
 * lives at the dispatcher layer rather than through MiniAppHost/React.
 */

function makeManifest(): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id: 'com.openmini.persistence-test',
    name: 'Persistence Test App',
    version: '0.1.0',
    entry: 'index.html',
    permissions: ['storage'],
  };
}

function createFakeSandbox(): { sandbox: MiniAppSandbox; destroy: () => void } {
  const listeners = new Set<SandboxStateListener>();
  const destroy = () => {
    for (const listener of listeners) listener('destroyed');
  };
  const sandbox: MiniAppSandbox = {
    state: 'running',
    sessionId: 'session-1',
    start: async () => undefined,
    destroy,
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { sandbox, destroy };
}

function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * storage.set/get chain multiple awaited IndexedDB requests (get, then
 * getUsedBytes, then set/get itself), each of which resolves on its own
 * macrotask via fake-indexeddb — a single tick isn't enough to observe the
 * dispatcher's response. Poll instead of guessing a fixed tick count.
 */
async function waitForResponse(responses: BridgeResponseEnvelope[], index: number): Promise<void> {
  for (let attempt = 0; attempt < 50 && responses.length <= index; attempt += 1) {
    await tick();
  }
}

function requestEnvelope(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'session-1',
    type: 'request' as const,
    requestId: 'req-1',
    method: 'storage.set',
    params: { key: 'greeting', value: 'hi' },
    ...overrides,
  };
}

describe('storage.* persistence across a simulated destroy/recreate', () => {
  it('a value set before destroy is readable by a freshly-recreated dispatcher for the same Mini App', async () => {
    const dbName = 'dispatcher-persistence-test';
    const manifest = makeManifest();

    // "Before destroy": load the Mini App, set a value.
    const before = createFakeSandbox();
    const channelBefore = new MessageChannel();
    const responsesBefore: BridgeResponseEnvelope[] = [];
    channelBefore.port2.onmessage = (event) =>
      responsesBefore.push(event.data as BridgeResponseEnvelope);

    createBridgeDispatcher({
      manifest,
      sandbox: before.sandbox,
      port: channelBefore.port1,
      handlers: {
        storage: createStorageHandlers({ provider: createIndexedDbStorageProvider(dbName) }),
      },
    });
    channelBefore.port2.postMessage(
      requestEnvelope({ params: { key: 'greeting', value: 'still here' } }),
    );
    await waitForResponse(responsesBefore, 0);
    expect(responsesBefore[0]).toMatchObject({ ok: true });

    // Destroy — tears the dispatcher down, same as a real sandbox teardown.
    before.destroy();

    // "After recreate": a brand new sandbox, port pair, dispatcher, and
    // storage provider instance — but the same underlying IndexedDB database
    // and the same manifest id.
    const after = createFakeSandbox();
    const channelAfter = new MessageChannel();
    const responsesAfter: BridgeResponseEnvelope[] = [];
    channelAfter.port2.onmessage = (event) =>
      responsesAfter.push(event.data as BridgeResponseEnvelope);

    createBridgeDispatcher({
      manifest,
      sandbox: after.sandbox,
      port: channelAfter.port1,
      handlers: {
        storage: createStorageHandlers({ provider: createIndexedDbStorageProvider(dbName) }),
      },
    });
    channelAfter.port2.postMessage(
      requestEnvelope({ method: 'storage.get', params: { key: 'greeting' } }),
    );
    await waitForResponse(responsesAfter, 0);

    expect(responsesAfter[0]).toMatchObject({ ok: true, result: 'still here' });
  });
});
