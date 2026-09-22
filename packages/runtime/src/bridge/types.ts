import type { OpenMiniManifest } from '@openmini/manifest';
import type { MiniAppSandbox, PackageProvenance } from '../sandbox/types';

export interface BridgeHandlerContext {
  readonly sandbox: MiniAppSandbox;
  readonly manifest: OpenMiniManifest;
  /**
   * Provenance of the running package, or `undefined` when this dispatcher
   * was not created for a loaded package (a static fixture, a test).
   *
   * Handlers are the reason this is threaded this far. `manifest.id` is
   * self-asserted and is not a security boundary — see the storage note in
   * docs/security/bridge.md — so the handler that scopes storage by it is
   * precisely the code that will one day need to know whether that id was
   * ever verified. No handler reads this yet.
   */
  readonly provenance?: PackageProvenance;
}

export type BridgeMethodHandler = (
  params: unknown,
  ctx: BridgeHandlerContext,
) => unknown | Promise<unknown>;

/** namespace -> methodName -> handler. */
export type BridgeHandlerRegistry = Record<string, Record<string, BridgeMethodHandler> | undefined>;
