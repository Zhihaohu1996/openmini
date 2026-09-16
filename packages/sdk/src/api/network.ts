import type { NetworkFetchRequest, NetworkFetchResponse } from '@openmini/shared';
import type { BridgeClient } from '../bridge/client';

/**
 * The Mini-App-facing init. Note this is *not* the browser's `RequestInit`:
 * there is no `redirect`, `credentials`, `mode`, `referrerPolicy`,
 * `keepalive` or `signal` here, because the host fixes those itself and
 * there is deliberately no way to pass them.
 */
export type OpenMiniFetchInit = Omit<NetworkFetchRequest, 'url'>;

export interface OpenMiniNetworkApi {
  /**
   * Performs an HTTP(S) request through the host, which enforces the
   * manifest's `network.domains` allowlist. Only hosts declared there are
   * reachable, and the target must still permit the host's origin via CORS.
   */
  fetch(url: string, init?: OpenMiniFetchInit): Promise<NetworkFetchResponse>;
}

export function createNetworkApi(client: BridgeClient): OpenMiniNetworkApi {
  return {
    fetch: (url, init = {}) =>
      client.request('network.fetch', { url, ...init }) as Promise<NetworkFetchResponse>,
  };
}
