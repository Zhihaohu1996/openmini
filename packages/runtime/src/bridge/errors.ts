/**
 * Thrown by a method handler to signal malformed/invalid parameters. The
 * dispatcher catches this specifically and responds with `INVALID_PARAMS`;
 * any other thrown error becomes a generic `INTERNAL_ERROR` with no
 * detail leaked to the Mini App.
 */
export class BridgeInvalidParamsError extends Error {}
