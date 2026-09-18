import type { MiniAppStorageProvider } from './storageProvider';

const DEFAULT_DB_NAME = 'openmini-storage';
const DB_VERSION = 1;
const STORE_NAME = 'entries';
const APP_ID_INDEX = 'byAppId';

interface StoredEntry {
  appId: string;
  key: string;
  value: string;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function promisifyRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDatabase(dbName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: ['appId', 'key'] });
        store.createIndex(APP_ID_INDEX, 'appId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Real, durable `MiniAppStorageProvider` backed by IndexedDB in the host's
 * own (trusted) origin — the sandboxed Mini App iframe never touches this
 * directly, it only ever reaches it through the dispatcher's RPC path. See
 * docs/security/bridge.md.
 *
 * `getUsedBytes` scans all entries for the given `appId` via the `byAppId`
 * index and sums real content on every call rather than maintaining a
 * separate running total, so accounting can never drift from what is
 * actually stored (at the cost of an O(entries-for-this-app) scan per call,
 * which is acceptable given the small total-bytes quota this backs).
 *
 * Throws synchronously if `indexedDB` is not available in this environment
 * (e.g. a non-browser host embedding), rather than silently falling back to
 * a different backend.
 */
export function createIndexedDbStorageProvider(
  dbName: string = DEFAULT_DB_NAME,
): MiniAppStorageProvider {
  if (typeof indexedDB === 'undefined') {
    throw new Error(
      'createIndexedDbStorageProvider requires a browser environment with IndexedDB support',
    );
  }

  const dbPromise = openDatabase(dbName);

  async function withStore<T>(
    mode: 'readonly' | 'readwrite',
    run: (store: IDBObjectStore) => Promise<T>,
  ): Promise<T> {
    const db = await dbPromise;
    const transaction = db.transaction(STORE_NAME, mode);
    const store = transaction.objectStore(STORE_NAME);
    return run(store);
  }

  return {
    async get(appId, key) {
      const entry = await withStore('readonly', (store) =>
        promisifyRequest(store.get([appId, key]) as IDBRequest<StoredEntry | undefined>),
      );
      return entry?.value ?? null;
    },
    async set(appId, key, value) {
      await withStore('readwrite', (store) =>
        promisifyRequest(store.put({ appId, key, value } satisfies StoredEntry)),
      );
    },
    async getUsedBytes(appId) {
      const entries = await withStore('readonly', (store) => {
        const index = store.index(APP_ID_INDEX);
        return promisifyRequest(index.getAll(IDBKeyRange.only(appId)) as IDBRequest<StoredEntry[]>);
      });
      let total = 0;
      for (const entry of entries) {
        total += byteLength(entry.key) + byteLength(entry.value);
      }
      return total;
    },
  };
}
