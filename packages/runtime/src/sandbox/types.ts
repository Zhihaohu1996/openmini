import type { OpenMiniManifest } from '@openmini/manifest';

/**
 * Explicit sandbox lifecycle. `ready` and `running` are kept distinct even
 * though Phase 3 moves between them as soon as the handshake completes,
 * because splitting them later (loading UX, timeouts) is harder than
 * collapsing them now. `destroyed` is absorbing and reachable from any state.
 */
export type SandboxState = 'created' | 'loading' | 'ready' | 'running' | 'error' | 'destroyed';

export type SandboxErrorCode =
  | 'MANIFEST_INVALID'
  | 'LOAD_FAILED'
  | 'HANDSHAKE_TIMEOUT'
  | 'HANDSHAKE_INVALID'
  | 'NAVIGATED_AWAY';

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

export interface SandboxOptions {
  manifest: OpenMiniManifest;
  resourceProvider: MiniAppResourceProvider;
  container: HTMLElement;
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
