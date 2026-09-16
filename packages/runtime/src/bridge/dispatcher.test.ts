import type { OpenMiniManifest } from '@openmini/manifest';
import { OPENMINI_BRIDGE_CHANNEL, OPENMINI_BRIDGE_VERSION, type BridgeResponseEnvelope } from '@openmini/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MiniAppSandbox, SandboxStateListener } from '../sandbox/types';
import { createBridgeDispatcher } from './dispatcher';
import { BridgeNetworkError, BridgePermissionDeniedError } from './errors';
import type { BridgeHandlerRegistry } from './types';

function makeManifest(permissions: OpenMiniManifest['permissions']): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id: 'com.openmini.test',
    name: 'Test App',
    version: '0.1.0',
    entry: 'index.html',
    permissions,
  };
}

function createFakeSandbox(sessionId = 'session-1') {
  const listeners = new Set<SandboxStateListener>();
  const destroy = vi.fn(() => {
    for (const listener of listeners) listener('destroyed');
  });
  const sandbox: MiniAppSandbox = {
    state: 'running',
    sessionId,
    start: async () => undefined,
    destroy,
    onStateChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { sandbox, destroy };
}

function tick(times = 1): Promise<void> {
  return times <= 1
    ? new Promise((resolve) => setTimeout(resolve, 0))
    : tick(1).then(() => tick(times - 1));
}

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    channel: OPENMINI_BRIDGE_CHANNEL,
    version: OPENMINI_BRIDGE_VERSION,
    sessionId: 'session-1',
    type: 'request' as const,
    requestId: 'req-1',
    method: 'storage.get',
    params: { key: 'a' },
    ...overrides,
  };
}

function collectResponses(port: MessagePort): BridgeResponseEnvelope[] {
  const received: BridgeResponseEnvelope[] = [];
  port.onmessage = (event) => received.push(event.data as BridgeResponseEnvelope);
  return received;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createBridgeDispatcher', () => {
  it('dispatches a permitted, registered method and posts a success response', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    channel.port2.postMessage(request({ method: 'storage.set', params: { key: 'a', value: 'hi' } }));
    await tick(2);
    channel.port2.postMessage(request({ requestId: 'req-2', method: 'storage.get', params: { key: 'a' } }));
    await tick(2);

    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ requestId: 'req-2', ok: true, result: 'hi' });
  });

  it('passes the manifest through to the handler context', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);
    const manifest = makeManifest(['storage']);
    let seenManifestId: string | undefined;
    const handlers: BridgeHandlerRegistry = {
      storage: {
        get: (_params, ctx) => {
          seenManifestId = ctx.manifest.id;
          return null;
        },
      },
    };

    createBridgeDispatcher({ manifest, sandbox, port: channel.port1, handlers });
    channel.port2.postMessage(request());
    await tick(2);

    expect(received[0]).toMatchObject({ ok: true, result: null });
    expect(seenManifestId).toBe(manifest.id);
  });

  it('denies a call to a namespace absent from the manifest permissions', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest([]), sandbox, port: channel.port1 });
    channel.port2.postMessage(request());
    await tick(2);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ ok: false, error: { code: 'PERMISSION_DENIED' } });
  });

  it('rejects an unknown method within a permitted namespace', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    channel.port2.postMessage(request({ method: 'storage.wipeEverything' }));
    await tick(2);

    expect(received[0]).toMatchObject({ ok: false, error: { code: 'UNKNOWN_METHOD' } });
  });

  it('rejects malformed params with INVALID_PARAMS', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    channel.port2.postMessage(request({ method: 'storage.get', params: {} }));
    await tick(2);

    expect(received[0]).toMatchObject({ ok: false, error: { code: 'INVALID_PARAMS' } });
  });

  it.each([
    ['BridgePermissionDeniedError', new BridgePermissionDeniedError('denied'), 'PERMISSION_DENIED'],
    ['a NETWORK_REQUEST_FAILED', new BridgeNetworkError('NETWORK_REQUEST_FAILED', 'failed'), 'NETWORK_REQUEST_FAILED'],
    ['a NETWORK_TIMEOUT', new BridgeNetworkError('NETWORK_TIMEOUT', 'timed out'), 'NETWORK_TIMEOUT'],
    [
      'a NETWORK_RESPONSE_TOO_LARGE',
      new BridgeNetworkError('NETWORK_RESPONSE_TOO_LARGE', 'too large'),
      'NETWORK_RESPONSE_TOO_LARGE',
    ],
  ])('maps %s thrown by a handler to its own error code', async (_label, thrown, expectedCode) => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);
    const handlers: BridgeHandlerRegistry = {
      network: {
        fetch: () => {
          throw thrown;
        },
      },
    };

    createBridgeDispatcher({ manifest: makeManifest(['network']), sandbox, port: channel.port1, handlers });
    channel.port2.postMessage(request({ method: 'network.fetch', params: { url: 'https://api.example.com/' } }));
    await tick(2);

    expect(received[0]).toMatchObject({ ok: false, error: { code: expectedCode } });
  });

  it('still hides an unexpected handler failure behind INTERNAL_ERROR', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);
    const handlers: BridgeHandlerRegistry = {
      network: {
        fetch: () => {
          throw new Error('postgres://user:hunter2@internal-db/prod is unreachable');
        },
      },
    };

    createBridgeDispatcher({ manifest: makeManifest(['network']), sandbox, port: channel.port1, handlers });
    channel.port2.postMessage(request({ method: 'network.fetch', params: { url: 'https://api.example.com/' } }));
    await tick(2);

    expect(received[0]).toMatchObject({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'internal error' } });
    expect(JSON.stringify(received[0])).not.toContain('hunter2');
  });

  it('rejects a request with a stale/foreign sessionId', async () => {
    const { sandbox } = createFakeSandbox('session-1');
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    channel.port2.postMessage(request({ sessionId: 'wrong-session' }));
    await tick(2);

    expect(received[0]).toMatchObject({ ok: false, error: { code: 'SESSION_INVALID' } });
  });

  it('drops a forged/malformed message silently, without any response', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    channel.port2.postMessage({ not: 'a valid envelope' });
    await tick(2);

    expect(received).toHaveLength(0);
  });

  it('returns RATE_LIMITED once the in-flight cap is exceeded', async () => {
    const { sandbox } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);
    let releaseFirst: (() => void) | undefined;
    const handlers: BridgeHandlerRegistry = {
      storage: {
        get: () => new Promise((resolve) => { releaseFirst = () => resolve('ok'); }),
      },
    };

    createBridgeDispatcher({
      manifest: makeManifest(['storage']),
      sandbox,
      port: channel.port1,
      handlers,
      maxInFlightRequests: 1,
    });
    channel.port2.postMessage(request({ requestId: 'req-1' }));
    await tick(2);
    channel.port2.postMessage(request({ requestId: 'req-2' }));
    await tick(2);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({ requestId: 'req-2', ok: false, error: { code: 'RATE_LIMITED' } });

    releaseFirst?.();
    await tick(2);
    expect(received).toHaveLength(2);
    expect(received[1]).toMatchObject({ requestId: 'req-1', ok: true });
  });

  it('stops responding once the sandbox is destroyed', async () => {
    const { sandbox, destroy } = createFakeSandbox();
    const channel = new MessageChannel();
    const received = collectResponses(channel.port2);

    createBridgeDispatcher({ manifest: makeManifest(['storage']), sandbox, port: channel.port1 });
    destroy();
    channel.port2.postMessage(request());
    await tick(2);

    expect(received).toHaveLength(0);
  });

  describe('navigation.close closing sequence', () => {
    function closeRequest(overrides: Partial<Record<string, unknown>> = {}) {
      return request({ method: 'navigation.close', params: undefined, requestId: 'close-1', ...overrides });
    }

    it('calls sandbox.destroy() only after a matching close-ack is received', async () => {
      const { sandbox, destroy } = createFakeSandbox();
      const channel = new MessageChannel();
      const received = collectResponses(channel.port2);

      createBridgeDispatcher({ manifest: makeManifest(['navigation']), sandbox, port: channel.port1 });
      channel.port2.postMessage(closeRequest());
      await tick(2);

      expect(received[0]).toMatchObject({ requestId: 'close-1', ok: true });
      expect(destroy).not.toHaveBeenCalled();

      channel.port2.postMessage({
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId: sandbox.sessionId,
        type: 'close-ack',
        requestId: 'close-1',
      });
      await tick(2);

      expect(destroy).toHaveBeenCalledTimes(1);
    });

    it('drops any other message received during the closing window', async () => {
      const { sandbox, destroy } = createFakeSandbox();
      const channel = new MessageChannel();
      const received = collectResponses(channel.port2);

      createBridgeDispatcher({ manifest: makeManifest(['navigation', 'storage']), sandbox, port: channel.port1 });
      channel.port2.postMessage(closeRequest());
      await tick(2);
      expect(received).toHaveLength(1);

      channel.port2.postMessage(request({ requestId: 'req-during-closing', method: 'storage.get' }));
      await tick(2);

      expect(received).toHaveLength(1); // no second response
      expect(destroy).not.toHaveBeenCalled();
    });

    it('destroys the sandbox via the fallback timer if no close-ack ever arrives', async () => {
      vi.useFakeTimers();
      const { sandbox, destroy } = createFakeSandbox();
      const channel = new MessageChannel();
      collectResponses(channel.port2);

      createBridgeDispatcher({
        manifest: makeManifest(['navigation']),
        sandbox,
        port: channel.port1,
        closeAckTimeoutMs: 2000,
      });
      channel.port2.postMessage(closeRequest());
      await vi.advanceTimersByTimeAsync(0);

      expect(destroy).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(2000);

      expect(destroy).toHaveBeenCalledTimes(1);
    });
  });
});
