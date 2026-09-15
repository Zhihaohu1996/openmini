/**
 * Wire protocol for the Mini App JS Bridge (Phase 4): the request/response
 * RPC layer carried over the same port the Phase 3 handshake establishes.
 * This module is pure types/constants/validators — no dispatch logic, no
 * handler logic — so both @openmini/runtime (host) and @openmini/sdk
 * (mini-app) can agree on the wire format without either depending on the
 * other.
 */

/** Reused as-is by the Phase 3 handshake envelope (see @openmini/runtime's messaging.ts). */
export const OPENMINI_BRIDGE_CHANNEL = 'openmini' as const;
export const OPENMINI_BRIDGE_VERSION = 1 as const;

/**
 * The bridge namespaces Phase 4 recognizes, one per manifest permission of
 * the same name. Kept here (rather than importing @openmini/manifest's
 * ManifestPermission) so @openmini/shared stays dependency-free; the actual
 * manifest.permissions -> capability enforcement lives in
 * @openmini/runtime's bridge/capabilities.ts.
 */
export const BRIDGE_NAMESPACES = ['storage', 'navigation', 'user'] as const;
export type BridgeNamespace = (typeof BRIDGE_NAMESPACES)[number];

export const BRIDGE_ERROR_CODES = [
  'UNKNOWN_METHOD',
  'PERMISSION_DENIED',
  'INVALID_PARAMS',
  'SESSION_INVALID',
  'REQUEST_TIMEOUT',
  'RATE_LIMITED',
  'INTERNAL_ERROR',
] as const;
export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export interface BridgeRequestEnvelope {
  channel: typeof OPENMINI_BRIDGE_CHANNEL;
  version: typeof OPENMINI_BRIDGE_VERSION;
  sessionId: string;
  type: 'request';
  requestId: string;
  method: string;
  params: unknown;
}

export interface BridgeSuccessResponseEnvelope {
  channel: typeof OPENMINI_BRIDGE_CHANNEL;
  version: typeof OPENMINI_BRIDGE_VERSION;
  sessionId: string;
  type: 'response';
  requestId: string;
  ok: true;
  result: unknown;
}

export interface BridgeErrorResponseEnvelope {
  channel: typeof OPENMINI_BRIDGE_CHANNEL;
  version: typeof OPENMINI_BRIDGE_VERSION;
  sessionId: string;
  type: 'response';
  requestId: string;
  ok: false;
  error: { code: BridgeErrorCode; message: string };
}

export type BridgeResponseEnvelope = BridgeSuccessResponseEnvelope | BridgeErrorResponseEnvelope;

/**
 * Scoped to `navigation.close` only (see docs/security/bridge.md) — not a
 * general per-RPC acknowledgement. Confirms the Mini App actually received
 * the `navigation.close` success response before the host tears the
 * sandbox down.
 */
export interface BridgeCloseAckEnvelope {
  channel: typeof OPENMINI_BRIDGE_CHANNEL;
  version: typeof OPENMINI_BRIDGE_VERSION;
  sessionId: string;
  type: 'close-ack';
  requestId: string;
}

function isEnvelopeBase(value: unknown): value is Record<string, unknown> & { sessionId: string } {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.channel === OPENMINI_BRIDGE_CHANNEL &&
    candidate.version === OPENMINI_BRIDGE_VERSION &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0
  );
}

export function isBridgeRequestEnvelope(value: unknown): value is BridgeRequestEnvelope {
  if (!isEnvelopeBase(value)) {
    return false;
  }
  return (
    value.type === 'request' &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    typeof value.method === 'string' &&
    value.method.length > 0 &&
    'params' in value
  );
}

export function isBridgeResponseEnvelope(value: unknown): value is BridgeResponseEnvelope {
  if (!isEnvelopeBase(value)) {
    return false;
  }
  if (value.type !== 'response' || typeof value.requestId !== 'string' || value.requestId.length === 0) {
    return false;
  }
  if (value.ok === true) {
    return 'result' in value;
  }
  if (value.ok === false) {
    const error = value.error as Record<string, unknown> | undefined;
    return (
      typeof error === 'object' &&
      error !== null &&
      typeof error.code === 'string' &&
      (BRIDGE_ERROR_CODES as readonly string[]).includes(error.code) &&
      typeof error.message === 'string'
    );
  }
  return false;
}

export function isBridgeCloseAckEnvelope(value: unknown): value is BridgeCloseAckEnvelope {
  if (!isEnvelopeBase(value)) {
    return false;
  }
  return value.type === 'close-ack' && typeof value.requestId === 'string' && value.requestId.length > 0;
}
