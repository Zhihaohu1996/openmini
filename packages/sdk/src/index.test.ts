import { OPENMINI_BRIDGE_CHANNEL, OPENMINI_BRIDGE_VERSION } from '@openmini/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeConnectTarget } from './bridge/connect';
import { BridgeError } from './bridge/errors';
import { connectOpenMini, getSdkInfo, OPENMINI_SDK_VERSION } from './index';

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
    fire: (event: { source: unknown; data: unknown; ports: MessagePort[] }) =>
      listener?.(event as unknown as MessageEvent),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('@openmini/sdk', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_SDK_VERSION).toBe('0.1.0');
  });

  it('reports sdk and shared versions', () => {
    const info = getSdkInfo();
    expect(info.sdkVersion).toBe('0.1.0');
    expect(info.sharedVersion).toBe('0.1.0');
  });
});

describe('connectOpenMini', () => {
  const parentWindow = { marker: 'parent' };

  it('resolves with the four capability namespaces once the handshake completes', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn(), onmessage: null } as unknown as MessagePort;

    const promise = connectOpenMini({ target });
    fire({
      source: parentWindow,
      data: {
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId: 's1',
        type: 'handshake-init',
      },
      ports: [port],
    });

    const bridge = await promise;
    expect(Object.keys(bridge).sort()).toEqual(['navigation', 'network', 'storage', 'user']);
  });

  // R4 (Phase 8.5): this is the defect as a Mini App author meets it. Before
  // the fix this promise never settled, so `await connectOpenMini()` in the
  // scaffold's own entry script was an unconditional hang.
  it('rejects with HANDSHAKE_TIMEOUT when the host never completes the handshake', async () => {
    vi.useFakeTimers();
    const { target } = createFakeTarget(parentWindow);

    const promise = connectOpenMini({ target, connectTimeoutMs: 50 });
    const settled = promise.then(
      () => null,
      (error: unknown) => error,
    );

    await vi.advanceTimersByTimeAsync(50);

    const error = await settled;
    expect(error).toBeInstanceOf(BridgeError);
    expect((error as BridgeError).code).toBe('HANDSHAKE_TIMEOUT');
  });

  it('passes connectTimeoutMs through rather than always using the default', async () => {
    vi.useFakeTimers();
    const { target } = createFakeTarget(parentWindow);

    const state = { settled: false };
    void connectOpenMini({ target, connectTimeoutMs: 25 }).catch(() => {
      state.settled = true;
    });

    await vi.advanceTimersByTimeAsync(24);
    expect(state.settled).toBe(false);

    // Far short of the 10 000 ms default: the option is doing the work.
    await vi.advanceTimersByTimeAsync(1);
    expect(state.settled).toBe(true);
  });
});
