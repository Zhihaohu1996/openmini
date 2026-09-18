import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  type BridgeRequestEnvelope,
} from '@openmini/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBridgeClient } from './client';

afterEach(() => {
  vi.useRealTimers();
});

function respondOnce(
  port: MessagePort,
  sessionId: string,
  build: (req: BridgeRequestEnvelope) => Record<string, unknown>,
) {
  port.onmessage = (event) => {
    const req = event.data as BridgeRequestEnvelope;
    port.postMessage({
      channel: OPENMINI_BRIDGE_CHANNEL,
      version: OPENMINI_BRIDGE_VERSION,
      sessionId,
      ...build(req),
    });
  };
}

describe('createBridgeClient', () => {
  it('resolves request() when a matching success response arrives', async () => {
    const channel = new MessageChannel();
    respondOnce(channel.port2, 's1', (req) => ({
      type: 'response',
      requestId: req.requestId,
      ok: true,
      result: 'hello',
    }));
    const client = createBridgeClient({ port: channel.port1, sessionId: 's1' });

    await expect(client.request('storage.get', { key: 'a' })).resolves.toBe('hello');
  });

  it('rejects request() with a BridgeError when the host returns an error response', async () => {
    const channel = new MessageChannel();
    respondOnce(channel.port2, 's1', (req) => ({
      type: 'response',
      requestId: req.requestId,
      ok: false,
      error: { code: 'PERMISSION_DENIED', message: 'nope' },
    }));
    const client = createBridgeClient({ port: channel.port1, sessionId: 's1' });

    await expect(client.request('storage.get', { key: 'a' })).rejects.toMatchObject({
      code: 'PERMISSION_DENIED',
      message: 'nope',
    });
  });

  it('correlates multiple concurrent in-flight requests by requestId', async () => {
    const channel = new MessageChannel();
    channel.port2.onmessage = (event) => {
      const req = event.data as BridgeRequestEnvelope;
      channel.port2.postMessage({
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId: 's1',
        type: 'response',
        requestId: req.requestId,
        ok: true,
        result: req.method,
      });
    };
    const client = createBridgeClient({ port: channel.port1, sessionId: 's1' });

    const [a, b] = await Promise.all([
      client.request('storage.get', {}),
      client.request('user.getProfile', {}),
    ]);
    expect(a).toBe('storage.get');
    expect(b).toBe('user.getProfile');
  });

  it('rejects with REQUEST_TIMEOUT if no response arrives before the timeout', async () => {
    vi.useFakeTimers();
    const channel = new MessageChannel();
    const client = createBridgeClient({
      port: channel.port1,
      sessionId: 's1',
      requestTimeoutMs: 1000,
    });

    const assertion = expect(client.request('storage.get', { key: 'a' })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it('ignores a response that arrives after its request already timed out', async () => {
    vi.useFakeTimers();
    const channel = new MessageChannel();
    let capturedRequestId = '';
    channel.port2.onmessage = (event) => {
      capturedRequestId = (event.data as BridgeRequestEnvelope).requestId;
    };
    const client = createBridgeClient({
      port: channel.port1,
      sessionId: 's1',
      requestTimeoutMs: 5,
    });

    const assertion = expect(client.request('storage.get', { key: 'a' })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
    await vi.advanceTimersByTimeAsync(5);
    await assertion;

    expect(() =>
      channel.port2.postMessage({
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId: 's1',
        type: 'response',
        requestId: capturedRequestId,
        ok: true,
        result: 'late',
      }),
    ).not.toThrow();
  });

  it('ignores a response with a mismatched sessionId', async () => {
    const channel = new MessageChannel();
    respondOnce(channel.port2, 'wrong-session', (req) => ({
      type: 'response',
      requestId: req.requestId,
      ok: true,
      result: 'hello',
    }));
    const client = createBridgeClient({
      port: channel.port1,
      sessionId: 's1',
      requestTimeoutMs: 20,
    });

    await expect(client.request('storage.get', { key: 'a' })).rejects.toMatchObject({
      code: 'REQUEST_TIMEOUT',
    });
  });

  it('requestRaw exposes the requestId used for the call', async () => {
    const channel = new MessageChannel();
    let observedRequestId = '';
    channel.port2.onmessage = (event) => {
      observedRequestId = (event.data as BridgeRequestEnvelope).requestId;
    };
    const client = createBridgeClient({ port: channel.port1, sessionId: 's1' });

    const { requestId } = client.requestRaw('navigation.close', undefined);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(requestId).toBe(observedRequestId);
  });

  it('sendCloseAck posts a close-ack envelope carrying the given requestId', async () => {
    const channel = new MessageChannel();
    const received: unknown[] = [];
    channel.port2.onmessage = (event) => received.push(event.data);
    const client = createBridgeClient({ port: channel.port1, sessionId: 's1' });

    client.sendCloseAck('close-1');
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received[0]).toMatchObject({
      channel: OPENMINI_BRIDGE_CHANNEL,
      version: OPENMINI_BRIDGE_VERSION,
      sessionId: 's1',
      type: 'close-ack',
      requestId: 'close-1',
    });
  });
});
