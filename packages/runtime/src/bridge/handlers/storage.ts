import { BridgeInvalidParamsError, BridgeStorageQuotaExceededError } from '../errors';
import type { BridgeHandlerContext, BridgeMethodHandler } from '../types';
import { deriveStorageScope } from './storageScope';
import { resolveStorageScope, type MigrationOutcome } from './storageMigration';
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
  /**
   * Package ids whose pre-Phase-10 bare-id storage the host operator has
   * opted into carrying forward when the package loads verified.
   *
   * **Empty by default, and the default is the safe one.** The bare-id space
   * is the one the id-collision gap let any package at any origin write to,
   * so its bytes have no trustworthy writer. Adopting them automatically
   * would hand a verified package whatever an earlier squatter left there —
   * poison `com.example.notes`, wait for the real publisher to sign and
   * register, and the verified app reads attacker-controlled values as its
   * own. A confused deputy manufactured by the migration itself.
   *
   * An operator listing an id here is asserting "I know who was serving this
   * id before". Nothing in the data can assert it for them, which is why this
   * is a host decision and not an inference.
   *
   * Note this does not make the inherited data *attested*: a signature
   * attests the package, never the data the package inherits. The migration
   * record says so (`attested: false`).
   *
   * Adoption from the package's own origin-tier space is separate and
   * automatic — see `storageMigration.ts`.
   */
  adoptLegacyScopeForIds?: ReadonlySet<string>;
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
    adoptLegacyScopeForIds,
  } = options;

  function keyExceedsLimit(key: string): boolean {
    return byteLength(key) > maxKeyBytes;
  }

  /**
   * One resolution per scope, shared by every concurrent call.
   *
   * The **promise** is memoized, not its result, so a `get` and a `set` that
   * arrive together await the same migration rather than starting two. That
   * matters: two concurrent migrations would both write a `pending` record
   * and both copy, and while the protocol is convergent under that, doing it
   * once is cheaper and easier to reason about.
   *
   * A rejected resolution is evicted so the next call retries. A transient
   * provider failure should cost one call, not disable storage for the
   * lifetime of the sandbox.
   */
  const resolutions = new Map<string, Promise<ResolvedScope>>();

  interface ResolvedScope {
    key: string;
    outcome: MigrationOutcome;
  }

  async function scopeFor(ctx: BridgeHandlerContext): Promise<ResolvedScope> {
    const manifestId = ctx.manifest.id;
    // Derived first because it is pure and cheap, and because its key is what
    // the memo is keyed on.
    const base = deriveStorageScope({ manifestId, provenance: ctx.provenance });
    if (!base.ok) {
      // The Mini App did nothing wrong and learns nothing: the dispatcher maps
      // an unrecognized error to INTERNAL_ERROR with a generic message. This
      // is a host-side inconsistency — `verifyPackage` already asserts the
      // signed id equals the manifest id — and it must never fall back to a
      // weaker scope. See `deriveStorageScope`.
      throw new Error(`storage scope refused: ${base.reason}`);
    }

    const cacheKey = base.scope.key;
    const cached = resolutions.get(cacheKey);
    if (cached) {
      return cached;
    }

    const pending = resolveStorageScope({
      provider,
      manifestId,
      provenance: ctx.provenance,
      maxTotalBytes: maxTotalBytesPerApp,
      adoptLegacyScopeForIds,
    }).then((result): ResolvedScope => {
      if (!result.ok) {
        throw new Error(`storage scope refused: ${result.reason}`);
      }
      return { key: result.scope.key, outcome: result.outcome };
    });

    resolutions.set(
      cacheKey,
      pending.catch((error: unknown) => {
        resolutions.delete(cacheKey);
        throw error;
      }),
    );
    return resolutions.get(cacheKey) as Promise<ResolvedScope>;
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
      const scope = await scopeFor(ctx);
      return provider.get(scope.key, key);
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

      // Quota accounting follows the scope automatically: `getUsedBytes` is
      // asked about the same namespace the write lands in, so a package that
      // moved tiers is measured against its own data and not somebody else's.
      const appId = (await scopeFor(ctx)).key;
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
