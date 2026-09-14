/**
 * Minimal, versioned envelope for the one-time MessageChannel bootstrap
 * handshake. Phase 3 defines only `handshake-init`/`handshake-ack` — no
 * RPC, method dispatch, or capability fields. Those are deferred to the
 * future JS Bridge phase; this envelope is the substrate it will build on.
 */
export const OPENMINI_MESSAGE_CHANNEL = 'openmini' as const;
export const OPENMINI_PROTOCOL_VERSION = 1 as const;

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
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  if (globalCrypto && typeof globalCrypto.randomUUID === 'function') {
    return globalCrypto.randomUUID();
  }
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
export function isValidHandshakeAck(data: unknown, expectedSessionId: string): data is OpenMiniEnvelope {
  return isOpenMiniEnvelope(data) && data.type === 'handshake-ack' && data.sessionId === expectedSessionId;
}
