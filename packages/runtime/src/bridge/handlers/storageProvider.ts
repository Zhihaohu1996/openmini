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
export interface MiniAppStorageProvider {
  get(appId: string, key: string): Promise<string | null>;
  set(appId: string, key: string, value: string): Promise<void>;
  getUsedBytes(appId: string): Promise<number>;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
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
    async getUsedBytes(appId) {
      const store = getAppStore(appId);
      if (!store) {
        return 0;
      }
      let total = 0;
      for (const [key, value] of store) {
        total += byteLength(key) + byteLength(value);
      }
      return total;
    },
  };
}
