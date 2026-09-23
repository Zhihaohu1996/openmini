import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it } from 'vitest';
import { BridgeInvalidParamsError, BridgeStorageQuotaExceededError } from '../errors';
import type { BridgeHandlerContext } from '../types';
import { createInMemoryStorageProvider, type MiniAppStorageProvider } from './storageProvider';
import {
  createStorageHandlers,
  DEFAULT_MAX_KEY_BYTES,
  DEFAULT_MAX_TOTAL_BYTES_PER_APP,
  DEFAULT_MAX_VALUE_BYTES,
} from './storage';

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
    await expect(handlers.get?.({ key: 'a' }, makeContext('com.openmini.app-b'))).resolves.toBe(
      null,
    );
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

  it.each([[{ key: 'a' }], [{ key: 'a', value: 42 }]])(
    'set rejects malformed params %#',
    async (params) => {
      const handlers = createStorageHandlers();
      await expect(handlers.set?.(params, makeContext())).rejects.toThrow(BridgeInvalidParamsError);
    },
  );

  // R6 (Phase 8.5). `get` used to share `set`'s key-length check and so raised
  // STORAGE_QUOTA_EXCEEDED, making a read report a write-side failure mode and
  // contradicting docs/security/bridge.md, which lists quota errors for `set`
  // only. The two calls below use the *same* key, so the difference asserted
  // is purely the operation: only the one that consumes quota reports quota.
  describe('quota errors occur only on operations that consume quota', () => {
    const oversizedKey = 'k'.repeat(DEFAULT_MAX_KEY_BYTES + 1);

    it('get with an over-long key is an invalid argument, not a quota failure', async () => {
      const handlers = createStorageHandlers();
      const attempt = handlers.get?.({ key: oversizedKey }, makeContext());

      await expect(attempt).rejects.toThrow(BridgeInvalidParamsError);
      await expect(attempt).rejects.not.toThrow(BridgeStorageQuotaExceededError);
    });

    it('set with that same key is still a quota failure', async () => {
      const handlers = createStorageHandlers();
      await expect(
        handlers.set?.({ key: oversizedKey, value: 'v' }, makeContext()),
      ).rejects.toThrow(BridgeStorageQuotaExceededError);
    });

    it('rejects the over-long get key before consulting the provider', async () => {
      const calls: string[] = [];
      const provider: MiniAppStorageProvider = {
        ...createInMemoryStorageProvider(),
        get: async (_appId, key) => {
          calls.push(key);
          return null;
        },
      };
      const handlers = createStorageHandlers({ provider });

      await expect(handlers.get?.({ key: oversizedKey }, makeContext())).rejects.toThrow(
        BridgeInvalidParamsError,
      );
      expect(calls).toEqual([]);
    });
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
      await expect(handlers.set?.({ key: oversizedKey, value: 'v' }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
      await expect(handlers.get?.({ key: 'existing' }, ctx)).resolves.toBe('kept');
    });

    it('rejects a multi-byte-UTF-8 key whose string length is under the limit but byte length is over', async () => {
      const handlers = createStorageHandlers();
      // Each emoji is 2 UTF-16 code units (JS length) but 4 UTF-8 bytes.
      const key = '😀'.repeat(Math.ceil((DEFAULT_MAX_KEY_BYTES + 4) / 4));
      expect(key.length).toBeLessThan(DEFAULT_MAX_KEY_BYTES);
      expect(byteLength(key)).toBeGreaterThan(DEFAULT_MAX_KEY_BYTES);
      await expect(handlers.set?.({ key, value: 'v' }, makeContext())).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
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
      await expect(handlers.set?.({ key: 'k', value: oversizedValue }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe('original');
    });

    it('rejects a multi-byte-UTF-8 value whose string length is under the limit but byte length is over', async () => {
      const handlers = createStorageHandlers();
      const value = '😀'.repeat(Math.ceil((DEFAULT_MAX_VALUE_BYTES + 4) / 4));
      expect(value.length).toBeLessThan(DEFAULT_MAX_VALUE_BYTES);
      expect(byteLength(value)).toBeGreaterThan(DEFAULT_MAX_VALUE_BYTES);
      await expect(handlers.set?.({ key: 'k', value }, makeContext())).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
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

      await expect(handlers.set?.({ key: 'k2', value: 'x' }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
    });

    it('rejects a brand-new key at the total quota even with a tiny/empty value, proving key bytes alone count', async () => {
      const handlers = createStorageHandlers({ maxValueBytes: DEFAULT_MAX_TOTAL_BYTES_PER_APP });
      const ctx = makeContext();
      const value = 'v'.repeat(DEFAULT_MAX_TOTAL_BYTES_PER_APP - 1);
      await handlers.set?.({ key: 'k', value }, ctx);

      await expect(handlers.set?.({ key: 'brand-new-key', value: '' }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
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
      await expect(handlers.set?.({ key: 'k', value: biggerValue }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
      // Unchanged after the rejected overwrite.
      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe(value);
    });

    it('long keys with tiny values are accepted regardless of key length, as long as under the per-key and total limits', async () => {
      const handlers = createStorageHandlers();
      const key = 'k'.repeat(DEFAULT_MAX_KEY_BYTES);
      await expect(handlers.set?.({ key, value: '' }, makeContext())).resolves.toBeUndefined();
    });

    it('supports overriding the default limits via options', async () => {
      const handlers = createStorageHandlers({
        maxKeyBytes: 4,
        maxValueBytes: 4,
        maxTotalBytesPerApp: 8,
      });
      const ctx = makeContext();
      await expect(handlers.set?.({ key: 'toolong', value: 'v' }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
      await expect(handlers.set?.({ key: 'ok', value: 'toolong' }, ctx)).rejects.toThrow(
        BridgeStorageQuotaExceededError,
      );
      await expect(handlers.set?.({ key: 'ok', value: 'ok' }, ctx)).resolves.toBeUndefined();
    });

    it('accepts an explicitly supplied provider instead of the default in-memory one', async () => {
      // Asserted through the handler, and by the supplied provider now holding
      // an entry, rather than by reading a hardcoded appId out of it. Phase 10
      // made the storage key a derived scope, so a test that named the bare
      // manifest.id was pinning an internal layout rather than the behaviour
      // it describes — which is that the *supplied* provider is the one used.
      const provider: MiniAppStorageProvider = createInMemoryStorageProvider();
      const handlers = createStorageHandlers({ provider });
      const ctx = makeContext();

      await handlers.set?.({ key: 'k', value: 'via custom provider' }, ctx);

      await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBe('via custom provider');
      // A separate handler over its own default provider cannot see it, which
      // is what proves the supplied one was written to.
      await expect(createStorageHandlers().get?.({ key: 'k' }, ctx)).resolves.toBe(null);
    });
  });
});

/**
 * Handler-level scoping, on top of the derivation tests in
 * storageScope.test.ts and the protocol tests in storageMigration.test.ts.
 * These cover what only the handler can: that it awaits the resolution before
 * touching the provider, and shares one run across concurrent calls.
 */
describe('scope resolution at the handler', () => {
  const APP_ID = 'com.openmini.test';
  const ORIGIN = 'https://good.example';

  const verifiedCtx = (): BridgeHandlerContext => ({
    sandbox: {} as never,
    manifest: makeManifest(APP_ID),
    provenance: {
      baseUrl: `${ORIGIN}/app/`,
      identity: { verified: true, id: APP_ID, keyId: 'KEY-A' },
    },
  });

  it('refuses a storage call whose verified identity disagrees with the manifest', async () => {
    // Never downgraded to a weaker scope. The Mini App learns nothing: the
    // dispatcher maps an unrecognized error to INTERNAL_ERROR.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const ctx: BridgeHandlerContext = {
      sandbox: {} as never,
      manifest: makeManifest(APP_ID),
      provenance: {
        baseUrl: `${ORIGIN}/app/`,
        identity: { verified: true, id: 'com.example.someone-else', keyId: 'K' },
      },
    };

    await expect(handlers.get?.({ key: 'k' }, ctx)).rejects.toThrow(/identity-mismatch/);
    await expect(handlers.set?.({ key: 'k', value: 'v' }, ctx)).rejects.toThrow(
      /identity-mismatch/,
    );
  });

  it('writes nothing anywhere when it refuses an identity mismatch', async () => {
    // The negative control for the refusal above. Asserting only that the call
    // rejects would not catch a future `scopeFor` that caught the refusal and
    // fell back to the origin or legacy scope -- the call would still reject
    // on one path while quietly writing on another. So this checks every
    // namespace a fallback could plausibly reach, under BOTH ids involved in
    // the mismatch.
    const provider = createInMemoryStorageProvider();
    const handlers = createStorageHandlers({ provider });
    const claimedId = 'com.example.someone-else';
    const ctx: BridgeHandlerContext = {
      sandbox: {} as never,
      manifest: makeManifest(APP_ID),
      provenance: {
        baseUrl: `${ORIGIN}/app/`,
        identity: { verified: true, id: claimedId, keyId: 'K' },
      },
    };

    await expect(handlers.set?.({ key: 'k', value: 'v' }, ctx)).rejects.toThrow(
      /identity-mismatch/,
    );

    const reachableByAFallback = [
      `v1:id:${APP_ID}`,
      `v1:id:${claimedId}`,
      `v1:origin:${ORIGIN}|${APP_ID}`,
      `v1:origin:${ORIGIN}|${claimedId}`,
      APP_ID, // the bare/legacy space, which the embedded tier also uses
      claimedId,
      'v1:meta:migration',
    ];
    for (const scope of reachableByAFallback) {
      expect(await provider.entries(scope)).toEqual([]);
    }
  });

  it('does not serve the verified scope when the migration cannot complete', async () => {
    // "Never switch until conclusively complete" is what stops a half-copied
    // namespace from being served as if it were whole. A failing provider
    // means the call fails, not that it reads partial data.
    const inner = createInMemoryStorageProvider();
    await inner.set(`v1:origin:${ORIGIN}|${APP_ID}`, 'a', '1');
    await inner.set(`v1:origin:${ORIGIN}|${APP_ID}`, 'b', '2');

    let sets = 0;
    const crashing: MiniAppStorageProvider = {
      get: (a, k) => inner.get(a, k),
      entries: (a) => inner.entries(a),
      getUsedBytes: (a) => inner.getUsedBytes(a),
      async set(a, k, v) {
        sets += 1;
        if (sets === 3) throw new Error('simulated crash');
        return inner.set(a, k, v);
      },
    };

    const handlers = createStorageHandlers({ provider: crashing });
    await expect(handlers.get?.({ key: 'a' }, verifiedCtx())).rejects.toThrow(/simulated crash/);
  });

  it('shares one migration run across concurrent get and set', async () => {
    // The promise is memoized, not its result. Two concurrent calls must not
    // start two migrations.
    const inner = createInMemoryStorageProvider();
    await inner.set(`v1:origin:${ORIGIN}|${APP_ID}`, 'seed', 'value');

    let pendingRecordWrites = 0;
    const counting: MiniAppStorageProvider = {
      get: (a, k) => inner.get(a, k),
      entries: (a) => inner.entries(a),
      getUsedBytes: (a) => inner.getUsedBytes(a),
      async set(a, k, v) {
        if (a === 'v1:meta:migration' && v.includes('"pending"')) {
          pendingRecordWrites += 1;
        }
        return inner.set(a, k, v);
      },
    };

    const handlers = createStorageHandlers({ provider: counting });
    const ctx = verifiedCtx();
    await Promise.all([
      handlers.get?.({ key: 'seed' }, ctx),
      handlers.set?.({ key: 'other', value: 'x' }, ctx),
      handlers.get?.({ key: 'seed' }, ctx),
    ]);

    expect(pendingRecordWrites).toBe(1);
  });

  it('retries the resolution on a later call after a transient failure', async () => {
    // A rejected resolution is evicted from the memo. One bad call must not
    // disable storage for the lifetime of the sandbox.
    const inner = createInMemoryStorageProvider();
    let failNext = true;
    const flaky: MiniAppStorageProvider = {
      get: (a, k) => inner.get(a, k),
      getUsedBytes: (a) => inner.getUsedBytes(a),
      set: (a, k, v) => inner.set(a, k, v),
      async entries(a) {
        if (failNext) {
          failNext = false;
          throw new Error('transient');
        }
        return inner.entries(a);
      },
    };

    const handlers = createStorageHandlers({ provider: flaky });
    const ctx = verifiedCtx();

    await expect(handlers.get?.({ key: 'k' }, ctx)).rejects.toThrow(/transient/);
    await expect(handlers.get?.({ key: 'k' }, ctx)).resolves.toBeNull();
  });

  it('measures quota against the resolved scope, not the bare manifest id', async () => {
    const provider = createInMemoryStorageProvider();
    // Data parked at the bare id must not count against a verified package.
    await provider.set(APP_ID, 'squatter', 'x'.repeat(400));

    const handlers = createStorageHandlers({ provider, maxTotalBytesPerApp: 100 });
    await expect(
      handlers.set?.({ key: 'k', value: 'small' }, verifiedCtx()),
    ).resolves.toBeUndefined();
  });
});

/**
 * The compatibility guarantee for hosts that render static fixtures.
 *
 * Phase 10 changes where a *loaded* package's data lives. It must not change
 * where a fixture's data lives, because a fixture has no migration path --
 * adoption only ever runs for the verified tier -- so a moved key would be
 * silently orphaned IndexedDB contents with no route back.
 */
describe('provenance === undefined keeps its pre-Phase-10 storage location', () => {
  const APP_ID = 'com.openmini.test';

  it('reads data written at the bare manifest id before Phase 10', async () => {
    // Seeded the way a pre-Phase-10 host would have written it: straight at
    // the bare id, with no scope prefix.
    const provider = createInMemoryStorageProvider();
    await provider.set(APP_ID, 'existing', 'from an older release');

    const handlers = createStorageHandlers({ provider });

    await expect(handlers.get?.({ key: 'existing' }, makeContext(APP_ID))).resolves.toBe(
      'from an older release',
    );
  });

  it('writes back to the bare manifest id, not to a prefixed namespace', async () => {
    const provider = createInMemoryStorageProvider();
    const handlers = createStorageHandlers({ provider });

    await handlers.set?.({ key: 'k', value: 'v' }, makeContext(APP_ID));

    expect(await provider.entries(APP_ID)).toEqual([{ key: 'k', value: 'v' }]);
    // And nothing was written to a versioned namespace.
    expect(await provider.entries(`v1:embedded:${APP_ID}`)).toEqual([]);
    expect(await provider.entries(`v1:id:${APP_ID}`)).toEqual([]);
  });

  it('stays isolated from a loaded package claiming the same id', async () => {
    // Keeping the bare key is a compatibility choice, not a hole: a package
    // loaded from a URL always carries provenance, so it lands in a versioned
    // namespace and can never reach this one.
    const provider = createInMemoryStorageProvider();
    const handlers = createStorageHandlers({ provider });
    const loaded: BridgeHandlerContext = {
      sandbox: {} as never,
      manifest: makeManifest(APP_ID),
      provenance: {
        baseUrl: 'https://evil.example/app/',
        identity: { verified: false, reason: 'unsigned' },
      },
    };

    await handlers.set?.({ key: 'secret', value: 'fixture-only' }, makeContext(APP_ID));

    await expect(handlers.get?.({ key: 'secret' }, loaded)).resolves.toBeNull();
  });
});

/**
 * The host opt-in for carrying pre-Phase-10 bare-id data forward. The
 * migration module tests the rule; these test that the handler option
 * actually reaches it, and that its default is off.
 */
describe('adoptLegacyScopeForIds', () => {
  const APP_ID = 'com.openmini.test';
  const ORIGIN = 'https://good.example';

  const verifiedCtx = (): BridgeHandlerContext => ({
    sandbox: {} as never,
    manifest: makeManifest(APP_ID),
    provenance: {
      baseUrl: `${ORIGIN}/app/`,
      identity: { verified: true, id: APP_ID, keyId: 'KEY-A' },
    },
  });

  it('leaves legacy data alone by default', async () => {
    // The safe default. Those bytes were written when any package at any
    // origin could claim any id, so nothing vouches for them.
    const provider = createInMemoryStorageProvider();
    await provider.set(APP_ID, 'token', 'possibly-poisoned');

    const handlers = createStorageHandlers({ provider });

    await expect(handlers.get?.({ key: 'token' }, verifiedCtx())).resolves.toBeNull();
    // And the legacy data is still there, untouched.
    expect(await provider.entries(APP_ID)).toEqual([{ key: 'token', value: 'possibly-poisoned' }]);
  });

  it('carries legacy data forward when the operator opts that id in', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(APP_ID, 'token', 'abc');

    const handlers = createStorageHandlers({
      provider,
      adoptLegacyScopeForIds: new Set([APP_ID]),
    });

    await expect(handlers.get?.({ key: 'token' }, verifiedCtx())).resolves.toBe('abc');
    // Copied, not moved.
    expect(await provider.entries(APP_ID)).toEqual([{ key: 'token', value: 'abc' }]);
  });

  it('opting a different id in does not opt this one in', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(APP_ID, 'token', 'abc');

    const handlers = createStorageHandlers({
      provider,
      adoptLegacyScopeForIds: new Set(['com.example.someone-else']),
    });

    await expect(handlers.get?.({ key: 'token' }, verifiedCtx())).resolves.toBeNull();
  });

  it('does not let the opt-in reach an unverified package', async () => {
    // Adoption is verified-ward only. An unsigned package must never be
    // handed the legacy space, opt-in or not -- it has proved nothing.
    const provider = createInMemoryStorageProvider();
    await provider.set(APP_ID, 'token', 'abc');

    const handlers = createStorageHandlers({
      provider,
      adoptLegacyScopeForIds: new Set([APP_ID]),
    });
    const unsignedCtx: BridgeHandlerContext = {
      sandbox: {} as never,
      manifest: makeManifest(APP_ID),
      provenance: {
        baseUrl: `${ORIGIN}/app/`,
        identity: { verified: false, reason: 'unsigned' },
      },
    };

    await expect(handlers.get?.({ key: 'token' }, unsignedCtx)).resolves.toBeNull();
  });
});
