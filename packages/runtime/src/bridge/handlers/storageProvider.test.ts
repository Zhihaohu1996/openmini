import { describe, expect, it } from 'vitest';
import { createInMemoryStorageProvider } from './storageProvider';

describe('createInMemoryStorageProvider', () => {
  it('returns null for a key that was never set', async () => {
    const provider = createInMemoryStorageProvider();
    expect(await provider.get('app-a', 'missing')).toBe(null);
  });

  it('round-trips a value through set then get', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set('app-a', 'k', 'hello');
    expect(await provider.get('app-a', 'k')).toBe('hello');
  });

  it('isolates storage between different app ids', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set('app-a', 'k', 'a-value');
    expect(await provider.get('app-b', 'k')).toBe(null);
  });

  it('reports 0 used bytes for an app with no entries', async () => {
    const provider = createInMemoryStorageProvider();
    expect(await provider.getUsedBytes('app-a')).toBe(0);
  });

  it('computes used bytes as the sum of key + value UTF-8 byte lengths', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set('app-a', 'ab', 'hello'); // 2 + 5 = 7 bytes
    await provider.set('app-a', 'cde', 'hi'); // 3 + 2 = 5 bytes
    expect(await provider.getUsedBytes('app-a')).toBe(12);
  });

  it('measures multi-byte UTF-8 characters by byte length, not string length', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set('app-a', 'k', '😀'); // 1 JS UTF-16 "character" via surrogate pair, 4 UTF-8 bytes
    expect(await provider.getUsedBytes('app-a')).toBe(1 + 4); // key "k" (1 byte) + emoji (4 bytes)
  });

  it('overwriting a key replaces its contribution to used bytes rather than adding to it', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set('app-a', 'k', 'aaaaaaaaaa'); // 1 + 10 = 11 bytes
    await provider.set('app-a', 'k', 'bb'); // 1 + 2 = 3 bytes
    expect(await provider.getUsedBytes('app-a')).toBe(3);
  });

  it('scopes storage to one provider instance (a fresh instance starts empty)', async () => {
    const providerA = createInMemoryStorageProvider();
    await providerA.set('app-a', 'k', 'x');
    const providerB = createInMemoryStorageProvider();
    expect(await providerB.get('app-a', 'k')).toBe(null);
  });
});
