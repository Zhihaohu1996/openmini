import { describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { createNavigationApi } from './navigation';

describe('createNavigationApi', () => {
  it('close() awaits the response, then sends the close-ack for that requestId', async () => {
    const sendCloseAck = vi.fn();
    let resolveResult: (() => void) | undefined;
    const client: BridgeClient = {
      request: vi.fn(),
      requestRaw: vi.fn().mockReturnValue({
        requestId: 'close-1',
        result: new Promise<void>((resolve) => {
          resolveResult = resolve;
        }),
      }),
      sendCloseAck,
    };
    const api = createNavigationApi(client);

    const closePromise = api.close();
    expect(sendCloseAck).not.toHaveBeenCalled();

    resolveResult?.();
    await closePromise;

    expect(sendCloseAck).toHaveBeenCalledWith('close-1');
  });

  it('close() does not send an ack if the request rejects', async () => {
    const sendCloseAck = vi.fn();
    const client: BridgeClient = {
      request: vi.fn(),
      requestRaw: vi.fn().mockReturnValue({ requestId: 'close-1', result: Promise.reject(new Error('boom')) }),
      sendCloseAck,
    };
    const api = createNavigationApi(client);

    await expect(api.close()).rejects.toThrow('boom');
    expect(sendCloseAck).not.toHaveBeenCalled();
  });
});
