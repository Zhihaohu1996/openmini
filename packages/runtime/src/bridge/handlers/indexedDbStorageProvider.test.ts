import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { createIndexedDbStorageProvider } from './indexedDbStorageProvider';

// Each test uses a fresh database name so tests don't leak state into each
// other via the shared fake-indexeddb global.
let dbCounter = 0;
function freshDbName(): string {
  dbCounter += 1;
  return `test-db-${dbCounter}`;
}

describe('createIndexedDbStorageProvider', () => {
  it('returns null for a key that was never set', async () => {
    const provider = createIndexedDbStorageProvider(freshDbName());
    expect(await provider.get('app-a', 'missing')).toBe(null);
  });

  it('round-trips a value through set then get', async () => {
    const provider = createIndexedDbStorageProvider(freshDbName());
    await provider.set('app-a', 'k', 'hello');
    expect(await provider.get('app-a', 'k')).toBe('hello');
  });

  it('isolates storage between different app ids', async () => {
    const provider = createIndexedDbStorageProvider(freshDbName());
    await provider.set('app-a', 'k', 'a-value');
    expect(await provider.get('app-b', 'k')).toBe(null);
  });

  it('computes used bytes as the sum of key + value UTF-8 byte lengths for that app only', async () => {
    const provider = createIndexedDbStorageProvider(freshDbName());
    await provider.set('app-a', 'ab', 'hello'); // 2 + 5 = 7 bytes
    await provider.set('app-a', 'cde', 'hi'); // 3 + 2 = 5 bytes
    await provider.set('app-b', 'unrelated', 'should not count');
    expect(await provider.getUsedBytes('app-a')).toBe(12);
  });

  it('overwriting a key replaces its contribution to used bytes rather than adding to it', async () => {
    const provider = createIndexedDbStorageProvider(freshDbName());
    await provider.set('app-a', 'k', 'aaaaaaaaaa'); // 1 + 10 = 11 bytes
    await provider.set('app-a', 'k', 'bb'); // 1 + 2 = 3 bytes
    expect(await provider.getUsedBytes('app-a')).toBe(3);
  });

  it('survives destroy/recreate: a second, independently-constructed provider instance pointed at the same database still sees previously-written values', async () => {
    const dbName = freshDbName();
    const providerBeforeDestroy = createIndexedDbStorageProvider(dbName);
    await providerBeforeDestroy.set('com.openmini.example', 'greeting', 'still here');

    // Simulates the sandbox being destroyed and recreated: a brand new
    // provider instance, no shared in-memory state with the first one,
    // pointed at the same underlying database.
    const providerAfterRecreate = createIndexedDbStorageProvider(dbName);
    expect(await providerAfterRecreate.get('com.openmini.example', 'greeting')).toBe('still here');
    expect(await providerAfterRecreate.getUsedBytes('com.openmini.example')).toBeGreaterThan(0);
  });

  it('throws clearly when constructed in an environment without IndexedDB support', async () => {
    const originalIndexedDb = globalThis.indexedDB;
    // @ts-expect-error -- deliberately simulating a non-browser environment
    delete globalThis.indexedDB;
    try {
      expect(() => createIndexedDbStorageProvider(freshDbName())).toThrow(/IndexedDB/);
    } finally {
      globalThis.indexedDB = originalIndexedDb;
    }
  });
});
