import { OPENMINI_BRIDGE_CHANNEL, OPENMINI_BRIDGE_VERSION } from '@openmini/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CONNECT_TIMEOUT_MS,
  initOpenMiniBridge,
  type BridgeConnectTarget,
} from './connect';
import { BridgeError } from './errors';

function createFakeTarget(parent: unknown) {
  let listener: ((event: MessageEvent) => void) | null = null;
  const target: BridgeConnectTarget = {
    parent,
    addEventListener: (_type, l) => {
      listener = l;
    },
    removeEventListener: (_type, l) => {
      if (listener === l) {
        listener = null;
      }
    },
  };
  return {
    target,
    hasListener: (): boolean => listener !== null,
    fire: (event: { source: unknown; data: unknown; ports: MessagePort[] }) =>
      listener?.(event as unknown as MessageEvent),
  };
}

/**
 * Records how a promise settled without ever leaving it unhandled. The
 * handlers are attached immediately, which matters here: these tests
 * deliberately drive promises to rejection, and an unobserved rejection would
 * surface as a process-level failure rather than an assertion.
 */
function watch(promise: Promise<unknown>) {
  const state: { settled: boolean; error: unknown } = { settled: false, error: undefined };
  void promise.then(
    () => {
      state.settled = true;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

const validInit = {
  channel: OPENMINI_BRIDGE_CHANNEL,
  version: OPENMINI_BRIDGE_VERSION,
  sessionId: 's1',
  type: 'handshake-init' as const,
};

afterEach(() => {
  vi.useRealTimers();
});

describe('initOpenMiniBridge', () => {
  const parentWindow = { marker: 'parent' };

  it('resolves with sessionId/port and replies handshake-ack on a well-formed init', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const promise = initOpenMiniBridge(target);

    fire({ source: parentWindow, data: validInit, ports: [port] });

    const connection = await promise;
    expect(connection.sessionId).toBe('s1');
    expect(connection.port).toBe(port);
    expect(port.postMessage).toHaveBeenCalledWith({
      channel: OPENMINI_BRIDGE_CHANNEL,
      version: OPENMINI_BRIDGE_VERSION,
      sessionId: 's1',
      type: 'handshake-ack',
    });
  });

  it('removes its listener after accepting the handshake (a second init is a no-op)', async () => {
    const { target, fire, hasListener } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const promise = initOpenMiniBridge(target);
    fire({ source: parentWindow, data: validInit, ports: [port] });
    await promise;

    expect(hasListener()).toBe(false);

    const port2 = { postMessage: vi.fn() } as unknown as MessagePort;
    fire({ source: parentWindow, data: { ...validInit, sessionId: 's2' }, ports: [port2] });

    expect(port2.postMessage).not.toHaveBeenCalled();
  });

  it('clears the timeout on the success path, leaving nothing pending', async () => {
    vi.useFakeTimers();
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const promise = initOpenMiniBridge(target);

    expect(vi.getTimerCount()).toBe(1);
    fire({ source: parentWindow, data: validInit, ports: [port] });
    await promise;

    // A leaked timer would fire a rejection at an already-resolved promise and
    // keep the event loop alive for the full deadline.
    expect(vi.getTimerCount()).toBe(0);
  });

  // R4 (Phase 8.5). Every case below was previously an unconditional hang:
  // the promise had no reject path at all, so a Mini App whose host never
  // completed the handshake waited forever with no way to observe it.
  //
  // Each of these messages is still *ignored* rather than rejected on the
  // spot — a sandboxed document can receive messages from anywhere, and
  // rejecting on the first bad one would let any sender break the handshake.
  // The deadline is what makes the failure observable.
  describe('rejects with HANDSHAKE_TIMEOUT rather than hanging', () => {
    const timeoutMs = 1000;

    // `portCount` is the number of ports the bootstrap message carries; one is
    // the only acceptable value, so the rows that are not testing port count
    // use 1 and vary something else.
    it.each<[string, unknown, unknown, number]>([
      ['the event source is not the parent window (spoofing)', { marker: 'other' }, validInit, 1],
      ['no port was transferred', parentWindow, validInit, 0],
      ['more than one port was transferred', parentWindow, validInit, 2],
      ['the envelope is malformed', parentWindow, { foo: 'bar' }, 1],
      ['the protocol version does not match', parentWindow, { ...validInit, version: 'v999' }, 1],
      ['the channel does not match', parentWindow, { ...validInit, channel: 'other' }, 1],
      ['the session id is empty', parentWindow, { ...validInit, sessionId: '' }, 1],
      ['the type is not handshake-init', parentWindow, { ...validInit, type: 'response' }, 1],
    ])('%s', async (_label, source, data, portCount) => {
      vi.useFakeTimers();
      const { target, fire, hasListener } = createFakeTarget(parentWindow);
      const ports = Array.from(
        { length: portCount },
        () => ({ postMessage: vi.fn() }) as unknown as MessagePort,
      );

      const state = watch(initOpenMiniBridge(target, { connectTimeoutMs: timeoutMs }));
      fire({ source, data, ports });

      await vi.advanceTimersByTimeAsync(0);
      expect(state.settled).toBe(false); // ignored, not yet settled

      await vi.advanceTimersByTimeAsync(timeoutMs);

      expect(state.settled).toBe(true);
      expect(state.error).toBeInstanceOf(BridgeError);
      expect((state.error as BridgeError).code).toBe('HANDSHAKE_TIMEOUT');
      // No handshake-ack may be sent to a rejected bootstrap.
      for (const port of ports) {
        expect(port.postMessage).not.toHaveBeenCalled();
      }
      // The listener must go, on this path as well as on success.
      expect(hasListener()).toBe(false);
    });

    it('rejects when the host never posts anything at all', async () => {
      vi.useFakeTimers();
      const { target, hasListener } = createFakeTarget(parentWindow);

      const state = watch(initOpenMiniBridge(target, { connectTimeoutMs: timeoutMs }));
      await vi.advanceTimersByTimeAsync(timeoutMs);

      expect(state.settled).toBe(true);
      expect((state.error as BridgeError).code).toBe('HANDSHAKE_TIMEOUT');
      expect(hasListener()).toBe(false);
    });

    it('stays pending right up to the deadline', async () => {
      vi.useFakeTimers();
      const { target } = createFakeTarget(parentWindow);

      const state = watch(initOpenMiniBridge(target, { connectTimeoutMs: timeoutMs }));
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      expect(state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(state.settled).toBe(true);
    });

    it('still accepts a late-but-valid handshake arriving before the deadline', async () => {
      vi.useFakeTimers();
      const { target, fire } = createFakeTarget(parentWindow);
      const port = { postMessage: vi.fn() } as unknown as MessagePort;

      const promise = initOpenMiniBridge(target, { connectTimeoutMs: timeoutMs });
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      fire({ source: parentWindow, data: validInit, ports: [port] });

      await expect(promise).resolves.toMatchObject({ sessionId: 's1' });
      await vi.advanceTimersByTimeAsync(timeoutMs);
      expect(port.postMessage).toHaveBeenCalledTimes(1);
    });

    it('defaults the deadline to 10 seconds', async () => {
      vi.useFakeTimers();
      const { target } = createFakeTarget(parentWindow);

      expect(DEFAULT_CONNECT_TIMEOUT_MS).toBe(10_000);
      const state = watch(initOpenMiniBridge(target));

      await vi.advanceTimersByTimeAsync(DEFAULT_CONNECT_TIMEOUT_MS - 1);
      expect(state.settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect((state.error as BridgeError).code).toBe('HANDSHAKE_TIMEOUT');
    });
  });
});
