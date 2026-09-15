import type { OpenMiniManifest } from '@openmini/manifest';
import type { MiniAppSandbox } from '../sandbox/types';

export interface BridgeHandlerContext {
  readonly sandbox: MiniAppSandbox;
  readonly manifest: OpenMiniManifest;
}

export type BridgeMethodHandler = (params: unknown, ctx: BridgeHandlerContext) => unknown | Promise<unknown>;

/** namespace -> methodName -> handler. */
export type BridgeHandlerRegistry = Record<string, Record<string, BridgeMethodHandler> | undefined>;
