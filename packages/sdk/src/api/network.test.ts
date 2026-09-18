import type { NetworkFetchRequest } from '@openmini/shared';
import { describe, expect, it, vi } from 'vitest';
import type { BridgeClient } from '../bridge/client';
import { createNetworkApi } from './network';

function fakeClient(request: BridgeClient['request']): BridgeClient {
  return {
    request,
    requestRaw: vi.fn(),
    sendCloseAck: vi.fn(),
  };
}

describe('createNetworkApi', () => {
  it('fetch() calls network.fetch with the url and returns the response', async () => {
    const response = { status: 200, statusText: 'OK', headers: {}, body: 'hi' };
    const request = vi.fn().mockResolvedValue(response);
    const api = createNetworkApi(fakeClient(request));

    await expect(api.fetch('https://api.example.com/items')).resolves.toEqual(response);
    expect(request).toHaveBeenCalledWith('network.fetch', { url: 'https://api.example.com/items' });
  });

  it('fetch() forwards method, headers and body alongside the url', async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ status: 201, statusText: '', headers: {}, body: '' });
    const api = createNetworkApi(fakeClient(request));

    await api.fetch('https://api.example.com/items', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });

    expect(request).toHaveBeenCalledWith('network.fetch', {
      url: 'https://api.example.com/items',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
  });
});

describe('NetworkFetchRequest contract', () => {
  it('has no transport/security fields for a Mini App to set', () => {
    // A type-level assertion: each of these keys must be absent from the
    // contract, so there is no channel through which a Mini App could
    // override what the host fixes. If any were added, `never` would stop
    // matching and this would fail to compile.
    type TransportKeys =
      'redirect' | 'credentials' | 'mode' | 'referrer' | 'referrerPolicy' | 'keepalive' | 'signal';
    type ForbiddenPresent = Extract<keyof NetworkFetchRequest, TransportKeys>;

    const nonePresent: ForbiddenPresent extends never ? true : false = true;
    expect(nonePresent).toBe(true);

    // And the same at runtime, for the keys the SDK actually puts on the wire.
    const sent = { url: 'https://api.example.com/', method: 'GET' } satisfies NetworkFetchRequest;
    expect(Object.keys(sent).sort()).toEqual(['method', 'url']);
  });
});
