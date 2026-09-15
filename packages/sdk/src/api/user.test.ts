import { describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { createUserApi } from './user';

describe('createUserApi', () => {
  it('getProfile() calls user.getProfile and returns the result', async () => {
    const request = vi.fn().mockResolvedValue({ id: null, displayName: null });
    const client: BridgeClient = { request, requestRaw: vi.fn(), sendCloseAck: vi.fn() };
    const api = createUserApi(client);

    await expect(api.getProfile()).resolves.toEqual({ id: null, displayName: null });
    expect(request).toHaveBeenCalledWith('user.getProfile', undefined);
  });
});
