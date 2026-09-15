import { BridgeInvalidParamsError } from '../errors';
import type { BridgeMethodHandler } from '../types';

function readKey(params: unknown): string {
  if (typeof params !== 'object' || params === null || !('key' in params)) {
    throw new BridgeInvalidParamsError('expected { key: string }');
  }
  const key = (params as Record<string, unknown>).key;
  if (typeof key !== 'string' || key.length === 0) {
    throw new BridgeInvalidParamsError('"key" must be a non-empty string');
  }
  return key;
}

/**
 * Phase 4's only storage implementation: an in-memory Map scoped to one
 * dispatcher/sandbox instance. Explicitly NOT persistent — proves the
 * bridge plumbing, not a real storage subsystem. See docs/security/bridge.md.
 */
export function createStorageHandlers(): Record<string, BridgeMethodHandler> {
  const store = new Map<string, string>();

  return {
    get(params): string | null {
      const key = readKey(params);
      return store.has(key) ? (store.get(key) as string) : null;
    },
    set(params): undefined {
      const key = readKey(params);
      if (typeof params !== 'object' || params === null || !('value' in params)) {
        throw new BridgeInvalidParamsError('expected { key: string; value: string }');
      }
      const value = (params as Record<string, unknown>).value;
      if (typeof value !== 'string') {
        throw new BridgeInvalidParamsError('"value" must be a string');
      }
      store.set(key, value);
      return undefined;
    },
  };
}
