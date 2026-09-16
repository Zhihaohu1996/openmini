import { OPENMINI_SHARED_VERSION } from '@openmini/shared';
import { createStorageApi, type OpenMiniStorageApi } from './api/storage';
import { createNavigationApi, type OpenMiniNavigationApi } from './api/navigation';
import { createNetworkApi, type OpenMiniNetworkApi } from './api/network';
import { createUserApi, type OpenMiniUserApi } from './api/user';
import { createBridgeClient } from './bridge/client';
import { initOpenMiniBridge, type BridgeConnectTarget } from './bridge/connect';

export const OPENMINI_SDK_VERSION = '0.1.0';

export function getSdkInfo(): { sdkVersion: string; sharedVersion: string } {
  return {
    sdkVersion: OPENMINI_SDK_VERSION,
    sharedVersion: OPENMINI_SHARED_VERSION,
  };
}

export interface OpenMiniBridge {
  readonly storage: OpenMiniStorageApi;
  readonly navigation: OpenMiniNavigationApi;
  readonly user: OpenMiniUserApi;
  readonly network: OpenMiniNetworkApi;
}

export interface ConnectOpenMiniOptions {
  target?: BridgeConnectTarget;
  requestTimeoutMs?: number;
}

/**
 * Run once, from inside a Mini App document, to complete the handshake with
 * the host and get back the small `openmini.*` capability surface. See
 * docs/security/bridge.md for the full protocol.
 */
export async function connectOpenMini(options: ConnectOpenMiniOptions = {}): Promise<OpenMiniBridge> {
  const { sessionId, port } = await initOpenMiniBridge(options.target);
  const client = createBridgeClient({ port, sessionId, requestTimeoutMs: options.requestTimeoutMs });
  return {
    storage: createStorageApi(client),
    navigation: createNavigationApi(client),
    user: createUserApi(client),
    network: createNetworkApi(client),
  };
}

export { initOpenMiniBridge } from './bridge/connect';
export type { BridgeConnectTarget, OpenMiniBridgeConnection } from './bridge/connect';
export { createBridgeClient } from './bridge/client';
export type { BridgeClient, BridgeClientOptions, RawBridgeRequest } from './bridge/client';
export { BridgeError } from './bridge/errors';
export { createStorageApi } from './api/storage';
export type { OpenMiniStorageApi } from './api/storage';
export { createNavigationApi } from './api/navigation';
export type { OpenMiniNavigationApi } from './api/navigation';
export { createUserApi } from './api/user';
export type { OpenMiniUserApi, OpenMiniUserProfile } from './api/user';
export { createNetworkApi } from './api/network';
export type { OpenMiniFetchInit, OpenMiniNetworkApi } from './api/network';
