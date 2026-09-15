import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it, vi } from 'vitest';
import { createMiniAppSandbox, type SandboxRuntimeDeps } from './createSandbox';
import { OPENMINI_MESSAGE_CHANNEL, OPENMINI_PROTOCOL_VERSION } from './messaging';
import type { MiniAppResourceProvider, SandboxState } from './types';

function makeManifest(): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id: 'com.openmini.test',
    name: 'Test App',
    version: '0.1.0',
    entry: 'index.html',
    permissions: [],
  };
}

const okProvider: MiniAppResourceProvider = {
  readText: async () => '<h1>hi</h1>',
};

function tick(times = 1): Promise<void> {
  return times <= 1
    ? new Promise((resolve) => setTimeout(resolve, 0))
    : tick(1).then(() => tick(times - 1));
}

interface FakeIframe {
  element: HTMLIFrameElement;
  fireLoad: () => void;
  contentWindowPostMessage: ReturnType<typeof vi.fn>;
}

function createFakeIframe(): FakeIframe {
  const listeners: Record<string, Array<() => void>> = {};
  const contentWindowPostMessage = vi.fn();

  const element = {
    setAttribute: vi.fn(),
    addEventListener: (type: string, cb: () => void) => {
      listeners[type] = listeners[type] ?? [];
      listeners[type]?.push(cb);
    },
    removeEventListener: (type: string, cb: () => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== cb);
    },
    remove: vi.fn(),
    contentWindow: { postMessage: contentWindowPostMessage },
  } as unknown as HTMLIFrameElement;

  return {
    element,
    fireLoad: () => {
      for (const cb of listeners.load ?? []) cb();
    },
    contentWindowPostMessage,
  };
}

function createDeps(fakeIframe: FakeIframe): SandboxRuntimeDeps {
  return {
    createIframe: () => fakeIframe.element,
    createMessageChannel: () => new MessageChannel(),
  };
}

function createContainer() {
  return { appendChild: vi.fn() } as unknown as HTMLElement;
}

describe('createMiniAppSandbox', () => {
  it('transitions created -> loading -> ready -> running on a successful handshake', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const states: SandboxState[] = [];
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );
    sandbox.onStateChange((s) => states.push(s));

    expect(sandbox.state).toBe('created');
    await sandbox.start();
    expect(sandbox.state).toBe('loading');

    fakeIframe.fireLoad();
    expect(sandbox.state).toBe('ready');

    // Grab the port2 the sandbox transferred and reply on it, exactly as
    // the fixture's bootstrap script would.
    const sentMessage = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[0];
    const sentTargetOrigin = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[1];
    const sentTransfer = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[2] as MessagePort[];
    expect(sentTargetOrigin).toBe('*');
    expect(sentMessage).toMatchObject({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: sandbox.sessionId,
      type: 'handshake-init',
    });
    expect(sentTransfer).toHaveLength(1);

    sentTransfer[0]?.postMessage({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: sandbox.sessionId,
      type: 'handshake-ack',
    });
    await tick(3);

    expect(sandbox.state).toBe('running');
    expect(states).toEqual(['loading', 'ready', 'running']);
  });

  it('invokes onBridgeReady exactly once, with the handshaken port, when reaching running', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const onBridgeReady = vi.fn();
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer(), onBridgeReady },
      deps,
    );

    await sandbox.start();
    fakeIframe.fireLoad();
    expect(onBridgeReady).not.toHaveBeenCalled();

    const sentTransfer = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[2] as MessagePort[];
    sentTransfer[0]?.postMessage({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: sandbox.sessionId,
      type: 'handshake-ack',
    });
    await tick(3);

    expect(sandbox.state).toBe('running');
    expect(onBridgeReady).toHaveBeenCalledTimes(1);
    expect(onBridgeReady.mock.calls[0]?.[0]).toBeInstanceOf(MessagePort);
  });

  it('transitions to error when the resource provider fails to resolve the entry', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const failingProvider: MiniAppResourceProvider = {
      readText: async () => {
        throw new Error('boom');
      },
    };
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: failingProvider, container: createContainer() },
      deps,
    );

    await sandbox.start();
    expect(sandbox.state).toBe('error');
  });

  it('ignores a forged handshake-ack with the wrong sessionId', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );

    await sandbox.start();
    fakeIframe.fireLoad();

    const sentTransfer = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[2] as MessagePort[];
    sentTransfer[0]?.postMessage({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: 'not-the-real-session-id',
      type: 'handshake-ack',
    });
    await tick(3);

    expect(sandbox.state).toBe('ready');
  });

  it('reaches error on handshake timeout when no ack ever arrives', async () => {
    // Fake timers make this deterministic: the previous version raced a real
    // 5ms setTimeout against four chained 0ms setTimeout ticks, which is not
    // guaranteed to resolve in either order and was observed to flake under
    // real-world timer/event-loop scheduling (e.g. on CI runners). No
    // MessageChannel/MessagePort messaging happens in this test (no ack is
    // ever sent), so faking timers here doesn't interact with any real
    // cross-port message delivery.
    vi.useFakeTimers();
    try {
      const fakeIframe = createFakeIframe();
      const deps = createDeps(fakeIframe);
      const sandbox = createMiniAppSandbox(
        {
          manifest: makeManifest(),
          resourceProvider: okProvider,
          container: createContainer(),
          handshakeTimeoutMs: 5000,
        },
        deps,
      );

      await sandbox.start();
      fakeIframe.fireLoad();
      expect(sandbox.state).toBe('ready');

      await vi.advanceTimersByTimeAsync(5000);

      expect(sandbox.state).toBe('error');
    } finally {
      vi.useRealTimers();
    }
  });

  it('treats a second load event as a self-navigation and moves a running session to error', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );

    await sandbox.start();
    fakeIframe.fireLoad();
    const sentTransfer = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[2] as MessagePort[];
    sentTransfer[0]?.postMessage({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: sandbox.sessionId,
      type: 'handshake-ack',
    });
    await tick(3);
    expect(sandbox.state).toBe('running');

    fakeIframe.fireLoad();
    expect(sandbox.state).toBe('error');
  });

  it('destroy() is idempotent and reachable from every state', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );

    sandbox.destroy();
    expect(sandbox.state).toBe('destroyed');
    sandbox.destroy();
    expect(sandbox.state).toBe('destroyed');
  });

  it('after destroy(), a stale ack replayed on the old port is a no-op', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );

    await sandbox.start();
    fakeIframe.fireLoad();
    const sentTransfer = fakeIframe.contentWindowPostMessage.mock.calls[0]?.[2] as MessagePort[];

    sandbox.destroy();
    expect(sandbox.state).toBe('destroyed');

    sentTransfer[0]?.postMessage({
      channel: OPENMINI_MESSAGE_CHANNEL,
      version: OPENMINI_PROTOCOL_VERSION,
      sessionId: sandbox.sessionId,
      type: 'handshake-ack',
    });
    await tick(3);

    expect(sandbox.state).toBe('destroyed');
  });

  it('onStateChange unsubscribe stops delivering further events', async () => {
    const fakeIframe = createFakeIframe();
    const deps = createDeps(fakeIframe);
    const sandbox = createMiniAppSandbox(
      { manifest: makeManifest(), resourceProvider: okProvider, container: createContainer() },
      deps,
    );
    const seen: SandboxState[] = [];
    const unsubscribe = sandbox.onStateChange((s) => seen.push(s));

    await sandbox.start();
    unsubscribe();
    fakeIframe.fireLoad();

    expect(seen).toEqual(['loading']);
  });
});
