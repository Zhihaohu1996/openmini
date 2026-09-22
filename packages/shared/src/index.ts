/**
 * @openmini/shared
 *
 * Shared types and utilities used across OpenMini packages.
 */

export const OPENMINI_SHARED_VERSION = '0.1.0';

export { generateRandomId } from './id';

export { buildMiniAppCsp, MINI_APP_BASE_CSP_DIRECTIVES, MINI_APP_SANDBOX_ATTRIBUTE } from './csp';

export {
  base64ToBytes,
  base64UrlEncode,
  bytesToBase64,
  digestsEqual,
  sha256,
  sha256Base64,
  sha256Base64Utf8,
} from './crypto';

export {
  INTEGRITY_ALGORITHM,
  INTEGRITY_PAYLOAD_VERSION,
  SIGNATURE_ENVELOPE_VERSION,
  SIGNATURE_FILENAME,
  computeKeyId,
  generateSigningKeyPair,
  importSigningKey,
  importVerifyingKey,
  parseSignatureEnvelope,
  serializeIntegrityPayload,
  serializeSignatureEnvelope,
  signIntegrityPayload,
  verifySignatureEnvelope,
  verifySignatureFile,
} from './integrity';
export type {
  IntegrityPayload,
  ParseEnvelopeResult,
  SignatureEnvelope,
  SigningKeyPair,
  VerifyResult,
} from './integrity';

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

export {
  NETWORK_FETCH_METHODS,
  NETWORK_BODILESS_METHODS,
  isNetworkFetchMethod,
} from './bridge/network';
export type {
  NetworkFetchMethod,
  NetworkFetchRequest,
  NetworkFetchResponse,
} from './bridge/network';
