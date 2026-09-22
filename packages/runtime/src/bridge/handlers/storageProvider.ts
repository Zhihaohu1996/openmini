/**
 * Backend abstraction for `openmini.storage.*` (see docs/security/bridge.md).
 * A provider is pure storage — get/set plus a total-bytes query — and knows
 * nothing about quota limits or byte-counting rules; those are enforced by
 * `storage.ts` against whichever provider is plugged in, so every provider
 * gets the same quota behavior for free.
 *
 * `getUsedBytes` must reflect the sum of (key bytes + value bytes) actually
 * stored for `appId` across all of its keys, computed from real content
 * rather than a separately-tracked running total, so it can never drift from
 * what is actually persisted.
 */
export interface StorageEntry {
  readonly key: string;
  readonly value: string;
}

export interface MiniAppStorageProvider {
  get(appId: string, key: string): Promise<string | null>;
  set(appId: string, key: string, value: string): Promise<void>;
  /**
   * Every entry stored under `appId`, in no guaranteed order.
   *
   * Added for the Phase 10 storage migration, which has to copy one scope's
   * contents into another and report how much it found. `getUsedBytes` is
   * now derived from this, so the two can never disagree about what is
   * stored — previously each provider summed its own scan.
   *
   * Deliberately read-only: there is no `delete` and no `clear` on this
   * interface. Migration copies and never removes, and an interface with no
   * deletion on it cannot be used to add deletion casually later.
   */
  entries(appId: string): Promise<readonly StorageEntry[]>;
  getUsedBytes(appId: string): Promise<number>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * The quota accounting rule, in one place: key bytes plus value bytes, summed
 * over real content rather than a separately-tracked running total, so it can
 * never drift from what is actually persisted.
 *
 * Shared by every provider so they cannot disagree about what "used" means.
 */
export function sumEntryBytes(entries: readonly StorageEntry[]): number {
  let total = 0;
  for (const entry of entries) {
    total += byteLength(entry.key) + byteLength(entry.value);
  }
  return total;
}

/**
 * The default provider: a plain in-memory Map, scoped per provider instance.
 * Not persistent — matches Phase 4's original stub behavior exactly when no
 * provider is explicitly supplied to `createStorageHandlers`.
 */
export function createInMemoryStorageProvider(): MiniAppStorageProvider {
  const appStores = new Map<string, Map<string, string>>();

  function getAppStore(appId: string): Map<string, string> | undefined {
    return appStores.get(appId);
  }

  // A named local rather than `this.entries`: these methods are routinely
  // destructured off the provider, and `this` would be undefined the moment
  // one of them was.
  function readEntries(appId: string): StorageEntry[] {
    const store = getAppStore(appId);
    return store ? [...store].map(([key, value]) => ({ key, value })) : [];
  }

  return {
    async get(appId, key) {
      return getAppStore(appId)?.get(key) ?? null;
    },
    async set(appId, key, value) {
      let store = appStores.get(appId);
      if (!store) {
        store = new Map<string, string>();
        appStores.set(appId, store);
      }
      store.set(key, value);
    },
    async entries(appId) {
      return readEntries(appId);
    },
    async getUsedBytes(appId) {
      return sumEntryBytes(readEntries(appId));
    },
  };
}
