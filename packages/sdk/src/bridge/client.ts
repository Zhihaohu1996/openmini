import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  generateRandomId,
  isBridgeResponseEnvelope,
  type BridgeRequestEnvelope,
} from '@openmini/shared';
import { BridgeError } from './errors';

export interface BridgeClientOptions {
  port: MessagePort;
  sessionId: string;
  /** Defaults to 10000ms. */
  requestTimeoutMs?: number;
}

export interface RawBridgeRequest {
  requestId: string;
  result: Promise<unknown>;
}

export interface BridgeClient {
  /** Promise-based RPC for ordinary methods (storage.*, user.*, ...). */
  request(method: string, params: unknown): Promise<unknown>;
  /**
   * Lower-level form exposing the requestId, used only by
   * navigation.close's API wrapper so it can send the scoped close-ack
   * once the response arrives. Not a general mechanism — every other
   * caller uses `request()`.
   */
  requestRaw(method: string, params: unknown): RawBridgeRequest;
  /** Scoped to navigation.close only — see docs/security/bridge.md. */
  sendCloseAck(requestId: string): void;
}

interface PendingEntry {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Request/response client for the Mini App JS Bridge, run inside the
 * sandboxed document over the port `initOpenMiniBridge()` captured. Each
 * call gets a fresh requestId; a response is matched on requestId *and*
 * sessionId, and a response that arrives after its request already timed
 * out is treated as stale and ignored — mirroring the host dispatcher's
 * own late-message defense.
 */
export function createBridgeClient(options: BridgeClientOptions): BridgeClient {
  const { port, sessionId, requestTimeoutMs = 10_000 } = options;
  const pending = new Map<string, PendingEntry>();

  port.onmessage = (event: MessageEvent) => {
    const data: unknown = event.data;
    if (!isBridgeResponseEnvelope(data) || data.sessionId !== sessionId) {
      return;
    }
    const entry = pending.get(data.requestId);
    if (!entry) {
      return; // unknown/already-timed-out requestId — stale, ignored
    }
    pending.delete(data.requestId);
    clearTimeout(entry.timer);
    if (data.ok) {
      entry.resolve(data.result);
    } else {
      entry.reject(new BridgeError(data.error.code, data.error.message));
    }
  };

  function requestRaw(method: string, params: unknown): RawBridgeRequest {
    const requestId = generateRandomId();
    const result = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new BridgeError('REQUEST_TIMEOUT', 'the request timed out'));
      }, requestTimeoutMs);
      pending.set(requestId, { resolve, reject, timer });

      const envelope: BridgeRequestEnvelope = {
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId,
        type: 'request',
        requestId,
        method,
        params,
      };
      port.postMessage(envelope);
    });
    return { requestId, result };
  }

  return {
    request(method, params) {
      return requestRaw(method, params).result;
    },
    requestRaw,
    sendCloseAck(requestId) {
      port.postMessage({
        channel: OPENMINI_BRIDGE_CHANNEL,
        version: OPENMINI_BRIDGE_VERSION,
        sessionId,
        type: 'close-ack',
        requestId,
      });
    },
  };
}
