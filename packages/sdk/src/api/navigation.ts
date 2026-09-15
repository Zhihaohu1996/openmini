import type { BridgeClient } from '../bridge/client';

export interface OpenMiniNavigationApi {
  close(): Promise<void>;
}

/**
 * `close()` awaits the host's response, then sends the scoped close-ack the
 * host is waiting for before it tears the sandbox down (see
 * docs/security/bridge.md's navigation.close closing sequence). This is the
 * one place in the SDK that knows about close-ack — every other API module
 * just calls `client.request()`.
 */
export function createNavigationApi(client: BridgeClient): OpenMiniNavigationApi {
  return {
    async close(): Promise<void> {
      const { requestId, result } = client.requestRaw('navigation.close', undefined);
      await result;
      client.sendCloseAck(requestId);
    },
  };
}
