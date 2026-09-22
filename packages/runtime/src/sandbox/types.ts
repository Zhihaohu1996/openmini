import type { OpenMiniManifest } from '@openmini/manifest';

/**
 * Explicit sandbox lifecycle. `ready` and `running` are kept distinct even
 * though Phase 3 moves between them as soon as the handshake completes,
 * because splitting them later (loading UX, timeouts) is harder than
 * collapsing them now. `destroyed` is absorbing and reachable from any state.
 */
export type SandboxState = 'created' | 'loading' | 'ready' | 'running' | 'error' | 'destroyed';

export type SandboxErrorCode =
  'MANIFEST_INVALID' | 'LOAD_FAILED' | 'HANDSHAKE_TIMEOUT' | 'HANDSHAKE_INVALID' | 'NAVIGATED_AWAY';

export interface SandboxErrorInfo {
  code: SandboxErrorCode;
  message: string;
  cause?: unknown;
}

/**
 * Supplies the raw text content of a Mini App-relative resource. Phase 3
 * ships a single in-memory implementation (`StaticFixtureResourceProvider`);
 * a future filesystem- or HTTP-backed provider implements the same shape,
 * fetching/reading internally, so no URL abstraction is needed here.
 */
export interface MiniAppResourceProvider {
  readText(relativePath: string): Promise<string>;
}

/**
 * Where a loaded package came from, and what its identity check concluded.
 *
 * This is the shape the whole package-loading path carries, from
 * `loadMiniAppFromUrl` down to a bridge handler. It is deliberately the
 * *final* shape rather than a placeholder that later grows: every layer
 * between the loader and a handler has to name this type, so widening it
 * later is a cross-layer edit, and the point of threading it now is to do
 * that edit exactly once.
 *
 * The `verified: true` arm is therefore unreachable today — nothing produces
 * a signature yet. That is intentional. Consumers should switch on
 * `identity.verified` now, so that when verification does land the compiler
 * has already forced every call site to say what it does with both answers.
 *
 * `baseUrl` is the *normalized* package root (see `normalizePackageBaseUrl`),
 * not the string a caller typed. A later check that compares a resource's
 * origin against the package's own must not be comparing against an
 * un-normalized value.
 */
export type PackageProvenance = {
  readonly baseUrl: string;
  readonly identity:
    | { readonly verified: true; readonly id: string; readonly keyId: string }
    | { readonly verified: false; readonly reason: 'unsigned' | 'untrusted-key' };
};

export interface SandboxOptions {
  manifest: OpenMiniManifest;
  resourceProvider: MiniAppResourceProvider;
  container: HTMLElement;
  /**
   * Provenance of the package this sandbox runs, when it came through the
   * package-loading path.
   *
   * Optional, and `undefined` is a distinct state from an unverified
   * identity — not a default to be filled in. `undefined` means this sandbox
   * was constructed directly, from a static fixture or a test, so no package
   * load happened and there is nothing to have verified. `identity.verified:
   * false` means a real package *was* loaded and failed to establish a
   * trusted identity. Collapsing the two would let a fixture masquerade as a
   * package that failed its check, which is exactly the distinction a later
   * fail-closed policy has to act on.
   *
   * Nothing reads this yet; it is carried so the verification work does not
   * have to re-thread it.
   */
  provenance?: PackageProvenance;
  /** Defaults to 5000ms. */
  handshakeTimeoutMs?: number;
  /**
   * Invoked exactly once, when the sandbox reaches `running`, handing over
   * the already-handshaken `MessagePort` for bridge/RPC use (see
   * @openmini/runtime's bridge/dispatcher.ts). The sandbox retains
   * ownership of closing this port on `destroy()`/`error` — callers must
   * not close it themselves.
   */
  onBridgeReady?: (port: MessagePort) => void;
}

export type SandboxStateListener = (state: SandboxState, info?: SandboxErrorInfo) => void;

export interface MiniAppSandbox {
  readonly state: SandboxState;
  readonly sessionId: string;
  start(): Promise<void>;
  /** Idempotent — safe to call more than once, from any state. */
  destroy(): void;
  /** Returns an unsubscribe function. */
  onStateChange(listener: SandboxStateListener): () => void;
}
