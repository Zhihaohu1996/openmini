import type { OpenMiniManifest } from '@openmini/manifest';
import {
  OPENMINI_BRIDGE_CHANNEL,
  OPENMINI_BRIDGE_VERSION,
  isBridgeCloseAckEnvelope,
  isBridgeRequestEnvelope,
  type BridgeErrorCode,
  type BridgeResponseEnvelope,
} from '@openmini/shared';
import type { MiniAppSandbox, PackageProvenance } from '../sandbox/types';
import { computePermittedNamespaces, getMethodNamespace, isNamespaceKnown } from './capabilities';
import {
  BridgeInvalidParamsError,
  BridgeNetworkError,
  BridgePermissionDeniedError,
  BridgeStorageQuotaExceededError,
} from './errors';
import { createNavigationHandlers } from './handlers/navigation';
import { createNetworkHandlers } from './handlers/network';
import { createStorageHandlers } from './handlers/storage';
import { createUserHandlers } from './handlers/user';
import type { BridgeHandlerRegistry } from './types';

const DEFAULT_MAX_IN_FLIGHT_REQUESTS = 32;
const DEFAULT_CLOSE_ACK_TIMEOUT_MS = 2000;
const NAVIGATION_CLOSE_METHOD = 'navigation.close';

export interface BridgeDispatcher {
  /** Stops routing and unsubscribes from the sandbox, without destroying it. */
  destroy(): void;
}

export interface BridgeDispatcherOptions {
  manifest: OpenMiniManifest;
  sandbox: MiniAppSandbox;
  port: MessagePort;
  /**
   * Provenance of the loaded package, passed straight through to every
   * handler's context. Omitted for a dispatcher that is not serving a loaded
   * package; see `BridgeHandlerContext.provenance` for why `undefined` and
   * an unverified identity are kept distinct.
   */
  provenance?: PackageProvenance;
  /** Defaults to the Phase 4 stub storage/navigation/user handlers. */
  handlers?: BridgeHandlerRegistry;
  /** Defaults to 32. */
  maxInFlightRequests?: number;
  /** Defaults to 2000ms. See the navigation.close closing sequence below. */
  closeAckTimeoutMs?: number;
}

function createDefaultHandlers(): BridgeHandlerRegistry {
  return {
    storage: createStorageHandlers(),
    navigation: createNavigationHandlers(),
    user: createUserHandlers(),
    network: createNetworkHandlers(),
  };
}

/**
 * Host-side request router for the Mini App JS Bridge. One dispatcher per
 * sandbox instance, wired up via the sandbox's `onBridgeReady` hook. See
 * docs/security/bridge.md for the full protocol/threat model.
 */
export function createBridgeDispatcher(options: BridgeDispatcherOptions): BridgeDispatcher {
  const {
    manifest,
    sandbox,
    port,
    provenance,
    handlers = createDefaultHandlers(),
    maxInFlightRequests = DEFAULT_MAX_IN_FLIGHT_REQUESTS,
    closeAckTimeoutMs = DEFAULT_CLOSE_ACK_TIMEOUT_MS,
  } = options;

  const permittedNamespaces = computePermittedNamespaces(manifest);
  let inFlight = 0;
  let closing = false;
  let destroyed = false;
  let closeAckTimer: ReturnType<typeof setTimeout> | null = null;
  let pendingCloseRequestId: string | null = null;

  function postResponse(requestId: string, result: unknown): void {
    if (destroyed) {
      return;
    }
    const response: BridgeResponseEnvelope = {
      channel: OPENMINI_BRIDGE_CHANNEL,
      version: OPENMINI_BRIDGE_VERSION,
      sessionId: sandbox.sessionId,
      type: 'response',
      requestId,
      ok: true,
      result,
    };
    port.postMessage(response);
  }

  function postError(requestId: string, code: BridgeErrorCode, message: string): void {
    if (destroyed) {
      return;
    }
    const response: BridgeResponseEnvelope = {
      channel: OPENMINI_BRIDGE_CHANNEL,
      version: OPENMINI_BRIDGE_VERSION,
      sessionId: sandbox.sessionId,
      type: 'response',
      requestId,
      ok: false,
      error: { code, message },
    };
    port.postMessage(response);
  }

  function clearCloseAckTimer(): void {
    if (closeAckTimer) {
      clearTimeout(closeAckTimer);
      closeAckTimer = null;
    }
  }

  /**
   * Runs once, however the closing sequence ends (a real close-ack, or the
   * fallback timer firing because none ever arrived). Idempotent via
   * `sandbox.destroy()`'s own idempotency.
   */
  function finishClosing(): void {
    clearCloseAckTimer();
    pendingCloseRequestId = null;
    sandbox.destroy();
  }

  function handleMessage(event: MessageEvent): void {
    if (destroyed) {
      return;
    }
    const data: unknown = event.data;

    if (closing) {
      // While closing, the only message that means anything is a close-ack
      // matching the pending navigation.close — everything else (a new
      // request, a duplicate close, a malformed message) is dropped
      // silently. No request can be accepted during this transition.
      if (
        isBridgeCloseAckEnvelope(data) &&
        data.sessionId === sandbox.sessionId &&
        data.requestId === pendingCloseRequestId
      ) {
        finishClosing();
      }
      return;
    }

    if (!isBridgeRequestEnvelope(data)) {
      return; // malformed/forged — dropped silently, no oracle for attackers
    }

    if (data.sessionId !== sandbox.sessionId) {
      postError(
        data.requestId,
        'SESSION_INVALID',
        'session id does not match this sandbox instance',
      );
      return;
    }

    const namespace = getMethodNamespace(data.method);
    if (!isNamespaceKnown(namespace)) {
      // Unknown namespace: same response as a denied permission, so an
      // unpermitted/nonexistent namespace can't be distinguished by a caller.
      postError(
        data.requestId,
        'PERMISSION_DENIED',
        'this Mini App does not have the required permission',
      );
      return;
    }
    if (!permittedNamespaces.has(namespace)) {
      postError(
        data.requestId,
        'PERMISSION_DENIED',
        'this Mini App does not have the required permission',
      );
      return;
    }

    const methodName = data.method.slice(namespace.length + 1);
    // The registry is a plain object, so a bare index lookup also reaches
    // everything on Object.prototype: `storage.constructor`,
    // `storage.toString` and friends would all resolve to callable values and
    // be invoked as bridge methods. The registry must be *closed* — only own,
    // callable properties are methods. `hasOwn` alone is not enough (an own
    // non-function would still pass) and the typeof check alone is not enough
    // (inherited functions would still pass), so both are required.
    const namespaceHandlers = handlers[namespace];
    const handler =
      namespaceHandlers !== undefined && Object.hasOwn(namespaceHandlers, methodName)
        ? namespaceHandlers[methodName]
        : undefined;
    if (typeof handler !== 'function') {
      postError(data.requestId, 'UNKNOWN_METHOD', `unknown method: ${data.method}`);
      return;
    }

    if (inFlight >= maxInFlightRequests) {
      postError(data.requestId, 'RATE_LIMITED', 'too many in-flight requests');
      return;
    }

    // navigation.close is special-cased: entering `closing` immediately
    // (before the handler runs) guarantees no further request can be
    // accepted once a valid, permitted close has been accepted, even while
    // the (trivial, synchronous) handler and response are still in flight.
    const isClose = data.method === NAVIGATION_CLOSE_METHOD;
    if (isClose) {
      closing = true;
      pendingCloseRequestId = data.requestId;
    }

    inFlight += 1;
    const requestId = data.requestId;
    Promise.resolve()
      .then(() => handler(data.params, { sandbox, manifest, provenance }))
      .then(
        (result) => {
          inFlight -= 1;
          postResponse(requestId, result);
          if (isClose && !destroyed) {
            // Wait for the client's close-ack before tearing the sandbox
            // down, so the response above is guaranteed to have been
            // delivered first. A bounded fallback ensures a broken or
            // malicious client can't hold the sandbox open forever.
            closeAckTimer = setTimeout(finishClosing, closeAckTimeoutMs);
          }
        },
        (error: unknown) => {
          inFlight -= 1;
          if (isClose) {
            // The close handler is a no-op and isn't expected to fail, but
            // if it somehow does, don't leave the sandbox stuck closing.
            closing = false;
            pendingCloseRequestId = null;
          }
          if (error instanceof BridgeInvalidParamsError) {
            postError(requestId, 'INVALID_PARAMS', error.message);
          } else if (error instanceof BridgeStorageQuotaExceededError) {
            postError(requestId, 'STORAGE_QUOTA_EXCEEDED', error.message);
          } else if (error instanceof BridgePermissionDeniedError) {
            postError(requestId, 'PERMISSION_DENIED', error.message);
          } else if (error instanceof BridgeNetworkError) {
            postError(requestId, error.code, error.message);
          } else {
            postError(requestId, 'INTERNAL_ERROR', 'internal error');
          }
        },
      );
  }

  port.onmessage = handleMessage;

  const unsubscribe = sandbox.onStateChange((state) => {
    if (state === 'destroyed') {
      destroyed = true;
      port.onmessage = null;
      clearCloseAckTimer();
      unsubscribe();
    }
  });

  return {
    destroy(): void {
      destroyed = true;
      port.onmessage = null;
      clearCloseAckTimer();
      unsubscribe();
    },
  };
}
