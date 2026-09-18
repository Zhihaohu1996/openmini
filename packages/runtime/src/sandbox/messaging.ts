import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  generateRandomId,
} from '@openmini/shared';

/**
 * Minimal, versioned envelope for the one-time MessageChannel bootstrap
 * handshake. Handshake-init/-ack are the only types defined here; the
 * Phase 4 JS Bridge's request/response/close-ack envelopes are a separate,
 * distinct family (see @openmini/shared's bridge/protocol.ts) that shares
 * only these same channel/version constants and travels over the same
 * post-handshake port.
 */
export const OPENMINI_MESSAGE_CHANNEL = OPENMINI_BRIDGE_CHANNEL;
export const OPENMINI_PROTOCOL_VERSION = OPENMINI_BRIDGE_VERSION;

export type OpenMiniMessageType = 'handshake-init' | 'handshake-ack';

const VALID_MESSAGE_TYPES: readonly OpenMiniMessageType[] = ['handshake-init', 'handshake-ack'];

export interface OpenMiniEnvelope {
  channel: typeof OPENMINI_MESSAGE_CHANNEL;
  version: typeof OPENMINI_PROTOCOL_VERSION;
  sessionId: string;
  type: OpenMiniMessageType;
}

export function isOpenMiniEnvelope(value: unknown): value is OpenMiniEnvelope {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  return (
    candidate.channel === OPENMINI_MESSAGE_CHANNEL &&
    candidate.version === OPENMINI_PROTOCOL_VERSION &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    typeof candidate.type === 'string' &&
    VALID_MESSAGE_TYPES.includes(candidate.type as OpenMiniMessageType)
  );
}

export function generateSessionId(): string {
  return generateRandomId();
}

/**
 * Minimal shape of the bootstrap `message` event, factored out so this
 * predicate can be unit-tested without a real DOM/window. The sandboxed
 * document's inline bootstrap script implements this same logic directly
 * (it cannot import this module — it runs in an isolated, opaque-origin
 * realm with no module loader shared with the host).
 */
export interface BootstrapMessageEventLike {
  readonly source: unknown;
  readonly data: unknown;
  readonly ports: readonly unknown[];
}

/**
 * Validates a single postMessage-delivered bootstrap event from the
 * sandboxed document's point of view: exact source identity (rejects
 * spoofing from any window other than the real parent), envelope shape,
 * and exactly one transferred MessagePort.
 */
export function isValidHandshakeInitEvent(
  event: BootstrapMessageEventLike,
  expectedSource: unknown,
): event is BootstrapMessageEventLike & { data: OpenMiniEnvelope } {
  if (event.source !== expectedSource) {
    return false;
  }
  if (!Array.isArray(event.ports) || event.ports.length !== 1) {
    return false;
  }
  if (!isOpenMiniEnvelope(event.data)) {
    return false;
  }
  return event.data.type === 'handshake-init';
}

/**
 * Validates a handshake-ack received by the host over its private
 * MessagePort: envelope shape, correct message type, and that the
 * `sessionId` matches the session the host is currently tracking (a stale
 * or foreign session id is rejected, not just a malformed shape).
 */
export function isValidHandshakeAck(
  data: unknown,
  expectedSessionId: string,
): data is OpenMiniEnvelope {
  return (
    isOpenMiniEnvelope(data) &&
    data.type === 'handshake-ack' &&
    data.sessionId === expectedSessionId
  );
}
