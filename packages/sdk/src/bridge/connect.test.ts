import { OPENMINI_BRIDGE_CHANNEL, OPENMINI_BRIDGE_VERSION } from '@openmini/shared';
import { describe, expect, it, vi } from 'vitest';
import { initOpenMiniBridge, type BridgeConnectTarget } from './connect';

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

const validInit = {
  channel: OPENMINI_BRIDGE_CHANNEL,
  version: OPENMINI_BRIDGE_VERSION,
  sessionId: 's1',
  type: 'handshake-init' as const,
};

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

  it('ignores an event from a source other than the expected parent (spoofing)', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const results: string[] = [];
    void initOpenMiniBridge(target).then((c) => results.push(c.sessionId));

    fire({ source: { marker: 'other' }, data: validInit, ports: [port] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results).toEqual([]);
    expect(port.postMessage).not.toHaveBeenCalled();
  });

  it('ignores an event with zero transferred ports', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const results: string[] = [];
    void initOpenMiniBridge(target).then((c) => results.push(c.sessionId));

    fire({ source: parentWindow, data: validInit, ports: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results).toEqual([]);
  });

  it('ignores an event with more than one transferred port', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port1 = { postMessage: vi.fn() } as unknown as MessagePort;
    const port2 = { postMessage: vi.fn() } as unknown as MessagePort;
    const results: string[] = [];
    void initOpenMiniBridge(target).then((c) => results.push(c.sessionId));

    fire({ source: parentWindow, data: validInit, ports: [port1, port2] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results).toEqual([]);
  });

  it('ignores a malformed envelope', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const results: string[] = [];
    void initOpenMiniBridge(target).then((c) => results.push(c.sessionId));

    fire({ source: parentWindow, data: { foo: 'bar' }, ports: [port] });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(results).toEqual([]);
  });

  it('removes its listener after accepting the handshake (a second init is a no-op)', async () => {
    const { target, fire } = createFakeTarget(parentWindow);
    const port = { postMessage: vi.fn() } as unknown as MessagePort;
    const promise = initOpenMiniBridge(target);
    fire({ source: parentWindow, data: validInit, ports: [port] });
    await promise;

    const port2 = { postMessage: vi.fn() } as unknown as MessagePort;
    fire({ source: parentWindow, data: { ...validInit, sessionId: 's2' }, ports: [port2] });

    expect(port2.postMessage).not.toHaveBeenCalled();
  });
});
