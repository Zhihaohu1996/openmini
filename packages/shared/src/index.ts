/**
 * @openmini/shared
 *
 * Shared types and utilities used across OpenMini packages.
 */

export const OPENMINI_SHARED_VERSION = '0.1.0';

export { generateRandomId } from './id';

export {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  BRIDGE_NAMESPACES,
  BRIDGE_ERROR_CODES,
  isBridgeRequestEnvelope,
  isBridgeResponseEnvelope,
  isBridgeCloseAckEnvelope,
} from './bridge/protocol';
export type {
  BridgeNamespace,
  BridgeErrorCode,
  BridgeRequestEnvelope,
  BridgeSuccessResponseEnvelope,
  BridgeErrorResponseEnvelope,
  BridgeResponseEnvelope,
  BridgeCloseAckEnvelope,
} from './bridge/protocol';

export { NETWORK_FETCH_METHODS, NETWORK_BODILESS_METHODS, isNetworkFetchMethod } from './bridge/network';
export type { NetworkFetchMethod, NetworkFetchRequest, NetworkFetchResponse } from './bridge/network';
