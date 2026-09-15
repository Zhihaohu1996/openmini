import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it } from 'vitest';
import { BridgeInvalidParamsError, BridgeStorageQuotaExceededError } from '../errors';
import type { BridgeHandlerContext } from '../types';
import { createInMemoryStorageProvider, type MiniAppStorageProvider } from './storageProvider';
import { createStorageHandlers, DEFAULT_MAX_KEY_BYTES, DEFAULT_MAX_TOTAL_BYTES_PER_APP, DEFAULT_MAX_VALUE_BYTES } from './storage';

function makeManifest(id: string): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Test App',
    version: '0.1.0',
    entry: 'index.html',
    permissions: ['storage'],
  };
}

function makeContext(appId = 'com.openmini.test'): BridgeHandlerContext {
  return {
    sandbox: {} as never,
    manifest: makeManifest(appId),
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

describe('createStorageHandlers', () => {
  it('returns null for a key that was never set', async () => {
    const handlers = createStorageHandlers();
    await expect(handlers.get?.({ key: 'missing' }, makeContext())).resolves.toBe(null);
  });

  it('round-trips a value through set then get', async () => {
    const handlers = createStorageHandlers();
    const ctx = makeContext();
    await handlers.set?.({ key: 'a', value: 'hello' }, ctx);
    await expect(handlers.get?.({ key: 'a' }, ctx)).resolves.toBe('hello');
  });

  it('scopes storage by manifest id (a different app id sees nothing)', async () => {
    const handlers = createStorageHandlers();
    await handlers.set?.({ key: 'a', value: 'x' }, makeContext('com.openmini.app-a'));
    await expect(handlers.get?.({ key: 'a' }, makeContext('com.openmini.app-b'))).resolves.toBe(null);
  });

  it('a fresh handler instance with no shared provider starts empty', async () => {
    const handlersA = createStorageHandlers();
    await handlersA.set?.({ key: 'a', value: 'x' }, makeContext());
    const handlersB = createStorageHandlers();
    await expect(handlersB.get?.({ key: 'a' }, makeContext())).resolves.toBe(null);
  });

  it.each([[undefined], [null], [{}], [{ key: 42 }], [{ key: '' }]])(
    'get rejects malformed params %#',
    async (params) => {
      const handlers = createStorageHandlers();
      await expect(handlers.get?.(params, makeContext())).rejects.toThrow(BridgeInvalidParamsError);
    },
  );

  it.each([[{ key: 'a' }], [{ key: 'a', value: 42 }]])('set rejects malformed params %#', async (params) => {
    const handlers = createStorageHandlers();
    await expect(handlers.set?.(params, makeContext())).rejects.toThrow(BridgeInvalidParamsError);
  });

  describe('quota enforcement', () => {
    it('accepts a key of exactly the max key byte limit', async () => {
      const handlers = createStorageHandlers();
      const key = 'k'.repeat(DEFAULT_MAX_KEY_BYTES);
      await expect(handlers.set?.({ key, value: 'v' }, makeContext())).resolves.toBeUndefined();
    });

    it('rejects a key one byte over the max key byte limit, leaving other data unchanged', async () => {
      const handlers = createStorageHandlers();
      const ctx = makeContext();
      await handlers.set?.({ key: 'existing', value: 'kept' }, ctx);

      const oversizedKey = 'k'.repeat(DEFAULT_MAX_KEY_BYTES + 1);
      await expect(handlers.set?.({ key: oversizedKey, value: 'v' }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
      await expect(handlers.get?.({ key: 'existing' }, ctx)).resolves.toBe('kept');
    });

    it('rejects a multi-byte-UTF-8 key whose string length is under the limit but byte length is over', async () => {
      const handlers = createStorageHandlers();
      // Each emoji is 2 UTF-16 code units (JS length) but 4 UTF-8 bytes.
      const key = '😀'.repeat(Math.ceil((DEFAULT_MAX_KEY_BYTES + 4) / 4));
      expect(key.length).toBeLessThan(DEFAULT_MAX_KEY_BYTES);
      expect(byteLength(key)).toBeGreaterThan(DEFAULT_MAX_KEY_BYTES);
      await expect(handlers.set?.({ key, value: 'v' }, makeContext())).rejects.toThrow(BridgeStorageQuotaExceededError);
    });

    it('accepts a value of exactly the max value byte limit', async () => {
      const handlers = createStorageHandlers();
      const value = 'v'.repeat(DEFAULT_MAX_VALUE_BYTES);
      await expect(handlers.set?.({ key: 'k', value }, makeContext())).resolves.toBeUndefined();
    });

    it('rejects a value one byte over the max value byte limit, leaving the prior value unchanged', async () => {
      const handlers = createStorageHandlers();
      const ctx = makeContext();
      await handlers.set?.({ key: 'k', value: 'original' }, ctx);

      const oversizedValue = 'v'.repeat(DEFAULT_MAX_VALUE_BYTES + 1);
      await expect(handlers.set?.({ key: 'k', value: oversizedValue }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe('original');
    });

    it('rejects a multi-byte-UTF-8 value whose string length is under the limit but byte length is over', async () => {
      const handlers = createStorageHandlers();
      const value = '😀'.repeat(Math.ceil((DEFAULT_MAX_VALUE_BYTES + 4) / 4));
      expect(value.length).toBeLessThan(DEFAULT_MAX_VALUE_BYTES);
      expect(byteLength(value)).toBeGreaterThan(DEFAULT_MAX_VALUE_BYTES);
      await expect(handlers.set?.({ key: 'k', value }, makeContext())).rejects.toThrow(BridgeStorageQuotaExceededError);
    });

    // These total-quota tests raise maxValueBytes well above the default (via
    // options) so a single large value can approach the (default)
    // maxTotalBytesPerApp without also tripping the separate per-value cap —
    // isolating the total-quota accounting logic under test from the
    // per-value limit exercised above.
    it('fills an app up to exactly the total byte quota, counting key + value bytes', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      // key "k" = 1 byte; value sized so key+value hits the total exactly.
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await expect(handlers.set?.({ key: 'k', value }, ctx)).resolves.toBeUndefined();
    });

    it('rejects one more byte on a new key once the app is already at its total quota', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await handlers.set?.({ key: 'k', value }, ctx);

      await expect(handlers.set?.({ key: 'k2', value: 'x' }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
    });

    it('rejects a brand-new key at the total quota even with a tiny/empty value, proving key bytes alone count', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await handlers.set?.({ key: 'k', value }, ctx);

      await expect(handlers.set?.({ key: 'brand-new-key', value: '' }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
    });

    it('overwrite accounting: shrinking an existing key at the total cap succeeds', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await handlers.set?.({ key: 'k', value }, ctx);

      // Only the old value's bytes are subtracted (not the key's, since the
      // key was already counted at first write) before the new size is
      // checked, so shrinking must succeed even while already at the cap.
      await expect(handlers.set?.({ key: 'k', value: 'small' }, ctx)).resolves.toBeUndefined();
      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe('small');
    });

    it('overwrite accounting: growing an existing key past the total cap is rejected', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await handlers.set?.({ key: 'k', value }, ctx);

      const biggerValue = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP);
      await expect(handlers.set?.({ key: 'k', value: biggerValue }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
      // Unchanged after the rejected overwrite.
      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe(value);
    });

    it('long keys with tiny values are accepted regardless of key length, as long as under the per-key and total limits', async () => {
      const handlers = createStorageHandlers();
      const key = 'k'.repeat(DEFAULT_MAX_KEY_BYTES);
      await expect(handlers.set?.({ key, value: '' }, makeContext())).resolves.toBeUndefined();
    });

    it('supports overriding the default limits via options', async () => {
      const handlers = createStorageHandlers({ maxKeyBytes: 4, maxValueBytes: 4, maxTotalBytesPerApp: 8 });
      const ctx = makeContext();
      await expect(handlers.set?.({ key: 'toolong', value: 'v' }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
      await expect(handlers.set?.({ key: 'ok', value: 'toolong' }, ctx)).rejects.toThrow(BridgeStorageQuotaExceededError);
      await expect(handlers.set?.({ key: 'ok', value: 'ok' }, ctx)).resolves.toBeUndefined();
    });

    it('accepts an explicitly supplied provider instead of the default in-memory one', async () => {
      const provider: MiniAppStorageProvider = createInMemoryStorageProvider();
      const handlers = createStorageHandlers({ provider });
      const ctx = makeContext();
      await handlers.set?.({ key: 'k', value: 'via custom provider' }, ctx);
      expect(await provider.get(ctx.manifest.id, 'k')).toBe('via custom provider');
    });
  });
});
