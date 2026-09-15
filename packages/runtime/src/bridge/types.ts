import type { MiniAppSandbox } from '../sandbox/types';

export interface BridgeHandlerContext {
  readonly sandbox: MiniAppSandbox;
}

export type BridgeMethodHandler = (params: unknown, ctx: BridgeHandlerContext) => unknown | Promise<unknown>;

/** namespace -> methodName -> handler. */
export type BridgeHandlerRegistry = Record<string, Record<string, BridgeMethodHandler> | undefined>;
