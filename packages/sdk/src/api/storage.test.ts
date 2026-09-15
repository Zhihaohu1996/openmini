import { describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { createStorageApi } from './storage';

function fakeClient(request: BridgeClient['request']): BridgeClient {
  return {
    request,
    requestRaw: vi.fn(),
    sendCloseAck: vi.fn(),
  };
}

describe('createStorageApi', () => {
  it('get() calls storage.get with the key and returns the result', async () => {
    const request = vi.fn().mockResolvedValue('value-a');
    const api = createStorageApi(fakeClient(request));

    await expect(api.get('a')).resolves.toBe('value-a');
    expect(request).toHaveBeenCalledWith('storage.get', { key: 'a' });
  });

  it('set() calls storage.set with the key and value', async () => {
    const request = vi.fn().mockResolvedValue(undefined);
    const api = createStorageApi(fakeClient(request));

    await api.set('a', 'hello');
    expect(request).toHaveBeenCalledWith('storage.set', { key: 'a', value: 'hello' });
  });
});
