import { OPENMINI_BRIDGE_CHANNEL, OPENMINI_BRIDGE_VERSION } from '@openmini/shared';
import { BridgeError } from './errors';

/** Default handshake deadline. See `InitOpenMiniBridgeOptions.connectTimeoutMs`. */
export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

interface HandshakeInitEnvelope {
  channel: typeof OPENMINI_BRIDGE_CHANNEL;
  version: typeof OPENMINI_BRIDGE_VERSION;
  sessionId: string;
  type: 'handshake-init';
}

function isHandshakeInit(data: unknown): data is HandshakeInitEnvelope {
  if (typeof data !== 'object' || data === null) {
    return false;
  }
  const candidate = data as Record<string, unknown>;
  return (
    candidate.channel === OPENMINI_BRIDGE_CHANNEL &&
    candidate.version === OPENMINI_BRIDGE_VERSION &&
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId.length > 0 &&
    candidate.type === 'handshake-init'
  );
}

/**
 * Minimal seam so this can be unit-tested with a plain fake, without
 * needing jsdom to emulate cross-frame postMessage/MessagePort transfer —
 * mirrors @openmini/runtime's `SandboxRuntimeDeps` pattern. Defaults to the
 * real `window` in production.
 */
export interface BridgeConnectTarget {
  readonly parent: unknown;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

export interface OpenMiniBridgeConnection {
  readonly sessionId: string;
  readonly port: MessagePort;
}

export interface InitOpenMiniBridgeOptions {
  /**
   * How long to wait for an acceptable handshake-init before rejecting with
   * `HANDSHAKE_TIMEOUT`. Defaults to 10 000 ms.
   *
   * This deadline is the *only* thing that settles the promise when the host
   * misbehaves. Every validation failure below is deliberately silent — a
   * message from the wrong source, with the wrong port count, or with a
   * malformed or version-mismatched envelope is ignored rather than rejected,
   * because a Mini App document can receive messages from anywhere and an
   * attacker must not be able to break the handshake by posting junk first.
   * Ignoring those messages is right; never settling was the defect.
   */
  connectTimeoutMs?: number;
}

/**
 * Runs inside the sandboxed Mini App document. Waits for the host's
 * bootstrap handshake-init, validates it (exact parent-window source, a
 * single transferred port, well-formed envelope), replies with
 * handshake-ack, and resolves with the captured session id and port.
 *
 * This generalizes the handshake-acceptance logic Phase 3's fixtures had
 * to hand-duplicate inline (they couldn't import module code from an
 * opaque-origin `srcdoc` document); a real Mini App bundle can now depend
 * on this directly instead of re-copying it.
 *
 * Always settles: it resolves on an accepted handshake, or rejects with
 * `BridgeError('HANDSHAKE_TIMEOUT')` after `connectTimeoutMs`. The listener
 * and the timer are cleaned up on both paths.
 */
export function initOpenMiniBridge(
  target: BridgeConnectTarget = window,
  options: InitOpenMiniBridgeOptions = {},
): Promise<OpenMiniBridgeConnection> {
  const { connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS } = options;

  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | null = null;

    function cleanup(): void {
      target.removeEventListener('message', onBootstrap);
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    }

    function onBootstrap(event: MessageEvent): void {
      if (event.source !== target.parent) {
        return;
      }
      if (!event.ports || event.ports.length !== 1) {
        return;
      }
      if (!isHandshakeInit(event.data)) {
        return;
      }
      const port = event.ports[0];
      if (!port) {
        return;
      }

      cleanup();
      const sessionId = event.data.sessionId;
      port.postMessage({
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId,
        type: 'handshake-ack',
      });
      resolve({ sessionId, port });
    }

    target.addEventListener('message', onBootstrap);

    timer = setTimeout(() => {
      timer = null;
      cleanup();
      reject(
        new BridgeError(
          'HANDSHAKE_TIMEOUT',
          `no handshake-init from the host within ${connectTimeoutMs}ms`,
        ),
      );
    }, connectTimeoutMs);
  });
}
