import { BridgeInvalidParamsError, BridgeStorageQuotaExceededError } from '../errors';
import type { BridgeHandlerContext, BridgeMethodHandler } from '../types';
import { createInMemoryStorageProvider, type MiniAppStorageProvider } from './storageProvider';

/** See docs/security/bridge.md's "Quota semantics" for the normative rules these implement. */
export const DEFAULT_MAX_KEY_BYTES = 512;
export const DEFAULT_MAX_VALUE_BYTES = 8192;
export const DEFAULT_MAX_TOTAL_BYTES_PER_APP = 524288;

export interface StorageHandlerOptions {
  /** Defaults to a fresh, non-persistent in-memory provider. */
  provider?: MiniAppStorageProvider;
  /** Defaults to 512 bytes. */
  maxKeyBytes?: number;
  /** Defaults to 8192 bytes (8 KiB). */
  maxValueBytes?: number;
  /** Defaults to 524288 bytes (512 KiB). */
  maxTotalBytesPerApp?: number;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

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
 * `openmini.storage.*` — see docs/security/bridge.md for the full quota
 * model. Storage is real and durable when a persistent `provider` (e.g.
 * `createIndexedDbStorageProvider()`) is supplied; with no provider, this
 * falls back to the original Phase 4 in-memory behavior.
 */
export function createStorageHandlers(
  options: StorageHandlerOptions = {},
): Record<string, BridgeMethodHandler> {
  const {
    provider = createInMemoryStorageProvider(),
    maxKeyBytes = DEFAULT_MAX_KEY_BYTES,
    maxValueBytes = DEFAULT_MAX_VALUE_BYTES,
    maxTotalBytesPerApp = DEFAULT_MAX_TOTAL_BYTES_PER_APP,
  } = options;

  function keyExceedsLimit(key: string): boolean {
    return byteLength(key) > maxKeyBytes;
  }

  return {
    async get(params, ctx: BridgeHandlerContext): Promise<string | null> {
      const key = readKey(params);
      // R6 (Phase 8.5): a read consumes no quota, so an over-long key here is
      // a malformed argument, not a quota failure — the same class of problem
      // as the other checks in `readKey`. Reporting STORAGE_QUOTA_EXCEEDED
      // made a read announce a write-side failure mode, and contradicted
      // docs/security/bridge.md, which lists quota errors for `set` only.
      if (keyExceedsLimit(key)) {
        throw new BridgeInvalidParamsError(`"key" exceeds the ${maxKeyBytes}-byte limit`);
      }
      return provider.get(ctx.manifest.id, key);
    },
    async set(params, ctx: BridgeHandlerContext): Promise<undefined> {
      const key = readKey(params);
      if (typeof params !== 'object' || params === null || !('value' in params)) {
        throw new BridgeInvalidParamsError('expected { key: string; value: string }');
      }
      const value = (params as Record<string, unknown>).value;
      if (typeof value !== 'string') {
        throw new BridgeInvalidParamsError('"value" must be a string');
      }

      // `set` does consume quota, so the same over-long key stays a quota
      // error here. The asymmetry with `get` above is the point of R6.
      if (keyExceedsLimit(key)) {
        throw new BridgeStorageQuotaExceededError(`key exceeds the ${maxKeyBytes}-byte limit`);
      }
      const valueBytes = byteLength(value);
      if (valueBytes > maxValueBytes) {
        throw new BridgeStorageQuotaExceededError(`value exceeds the ${maxValueBytes}-byte limit`);
      }

      const appId = ctx.manifest.id;
      const existingValue = await provider.get(appId, key);
      const currentTotal = await provider.getUsedBytes(appId);
      const candidateTotal =
        existingValue === null
          ? currentTotal + byteLength(key) + valueBytes
          : currentTotal - byteLength(existingValue) + valueBytes;
      if (candidateTotal > maxTotalBytesPerApp) {
        throw new BridgeStorageQuotaExceededError(
          `storing this value would exceed the ${maxTotalBytesPerApp}-byte total quota`,
        );
      }

      await provider.set(appId, key, value);
      return undefined;
    },
  };
}
