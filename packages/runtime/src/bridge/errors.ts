/**
 * Thrown by a method handler to signal malformed/invalid parameters. The
 * dispatcher catches this specifically and responds with `INVALID_PARAMS`;
 * any other thrown error becomes a generic `INTERNAL_ERROR` with no
 * detail leaked to the Mini App.
 */
export class BridgeInvalidParamsError extends Error {}

/**
 * Thrown by `storage.set` when a key/value/total-bytes quota limit would be
 * exceeded (see docs/security/bridge.md's quota semantics). The dispatcher
 * catches this specifically and responds with `STORAGE_QUOTA_EXCEEDED`.
 */
export class BridgeStorageQuotaExceededError extends Error {}

/**
 * Thrown when a capability denies a request on permission grounds from
 * *inside* a handler, rather than at the dispatcher's namespace gate — e.g.
 * `network.fetch` to a host absent from the manifest allowlist. The
 * dispatcher maps this to `PERMISSION_DENIED`, so it is indistinguishable
 * from the namespace-level denial, as intended.
 */
export class BridgePermissionDeniedError extends Error {}

/**
 * Thrown by `network.fetch` for the network-specific failure modes. The
 * `code` is carried explicitly because only some of them are honestly
 * knowable: the host reports `NETWORK_TIMEOUT`/`NETWORK_*_TOO_LARGE`
 * precisely because it caused them itself, while everything the browser's
 * network stack rejects collapses into `NETWORK_REQUEST_FAILED`.
 */
export class BridgeNetworkError extends Error {
  constructor(
    readonly code:
      | 'NETWORK_REQUEST_FAILED'
      | 'NETWORK_TIMEOUT'
      | 'NETWORK_REQUEST_TOO_LARGE'
      | 'NETWORK_RESPONSE_TOO_LARGE',
    message: string,
  ) {
    super(message);
  }
}
