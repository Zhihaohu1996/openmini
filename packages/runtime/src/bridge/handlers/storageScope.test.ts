import { describe, expect, it } from 'vitest';
import type { PackageProvenance } from '../../sandbox/types';
import {
  deriveStorageScope,
  legacyStorageScopeKey,
  RESERVED_META_SCOPE_PREFIX,
  STORAGE_SCOPE_VERSION,
} from './storageScope';

const APP_ID = 'com.example.notes';

const verified = (id: string, keyId = 'KEY-A', baseUrl = 'https://good.example/app/') =>
  ({ baseUrl, identity: { verified: true, id, keyId } }) satisfies PackageProvenance;

const unsigned = (baseUrl: string) =>
  ({ baseUrl, identity: { verified: false, reason: 'unsigned' } }) satisfies PackageProvenance;

const untrustedKey = (baseUrl: string) =>
  ({ baseUrl, identity: { verified: false, reason: 'untrusted-key' } }) satisfies PackageProvenance;

const keyOf = (result: ReturnType<typeof deriveStorageScope>): string => {
  if (!result.ok) throw new Error(`expected a scope, got refusal: ${result.reason}`);
  return result.scope.key;
};

describe('tiers', () => {
  it('puts a package that never went through a load in the embedded tier', () => {
    // A static fixture or a test. There is nobody to be isolated from.
    const result = deriveStorageScope({ manifestId: APP_ID });
    expect(result).toEqual({
      ok: true,
      scope: { key: `v1:embedded:${APP_ID}`, tier: 'embedded' },
    });
  });

  it('puts a verified package in a namespace named by its id alone', () => {
    const result = deriveStorageScope({ manifestId: APP_ID, provenance: verified(APP_ID) });
    expect(result).toEqual({ ok: true, scope: { key: `v1:id:${APP_ID}`, tier: 'verified' } });
  });

  it('puts an unsigned package in an origin-qualified namespace', () => {
    const result = deriveStorageScope({
      manifestId: APP_ID,
      provenance: unsigned('https://good.example/app/'),
    });
    expect(result).toEqual({
      ok: true,
      scope: { key: `v1:origin:https://good.example|${APP_ID}`, tier: 'origin' },
    });
  });

  it('treats untrusted-key exactly as unsigned', () => {
    // Scoping a signed-but-untrusted package by its signing key would be
    // storage trust-on-first-use: the first key to claim an id would own the
    // namespace forever, decided by nobody. Phase 9 lists TOFU as a non-goal.
    const base = 'https://good.example/app/';
    expect(keyOf(deriveStorageScope({ manifestId: APP_ID, provenance: untrustedKey(base) }))).toBe(
      keyOf(deriveStorageScope({ manifestId: APP_ID, provenance: unsigned(base) })),
    );
  });
});

describe('isolation', () => {
  it('separates the same id served from two different origins', () => {
    // The documented leak, in one assertion.
    const a = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://good.example/app/') }),
    );
    const b = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://evil.example/app/') }),
    );
    expect(a).not.toBe(b);
  });

  it('does NOT separate the same id served from two paths on one origin', () => {
    // The surviving residual, pinned deliberately. A path buys no isolation --
    // anyone who can publish at /evil/ can publish at /app/ -- while it would
    // break any app that moves. Two packages on one origin are already
    // mutually trusting.
    const a = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://host.example/a/') }),
    );
    const b = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://host.example/b/') }),
    );
    expect(a).toBe(b);
  });

  it('separates two different ids', () => {
    const a = keyOf(
      deriveStorageScope({ manifestId: 'com.example.a', provenance: verified('com.example.a') }),
    );
    const b = keyOf(
      deriveStorageScope({ manifestId: 'com.example.b', provenance: verified('com.example.b') }),
    );
    expect(a).not.toBe(b);
  });

  it('separates the three tiers for one id', () => {
    const keys = [
      keyOf(deriveStorageScope({ manifestId: APP_ID })),
      keyOf(deriveStorageScope({ manifestId: APP_ID, provenance: verified(APP_ID) })),
      keyOf(
        deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://h.example/a/') }),
      ),
    ];
    expect(new Set(keys).size).toBe(3);
  });
});

describe('rotation invariance', () => {
  it('gives a verified package the same namespace under a rotated signing key', () => {
    // A trust store entry is an ARRAY of acceptable keys precisely because
    // rotation means two are valid at once. If the namespace named the key,
    // rotating would move the app's data -- making routine key hygiene a
    // data-loss event, which is how you get operators who never rotate.
    const underKeyA = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: verified(APP_ID, 'KEY-A') }),
    );
    const underKeyB = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: verified(APP_ID, 'KEY-B') }),
    );
    expect(underKeyA).toBe(underKeyB);
  });

  it('gives a verified package the same namespace when it moves origin', () => {
    const atA = keyOf(
      deriveStorageScope({
        manifestId: APP_ID,
        provenance: verified(APP_ID, 'KEY-A', 'https://cdn-a.example/app/'),
      }),
    );
    const atB = keyOf(
      deriveStorageScope({
        manifestId: APP_ID,
        provenance: verified(APP_ID, 'KEY-A', 'https://cdn-b.example/app/'),
      }),
    );
    expect(atA).toBe(atB);
  });
});

describe('origin normalization', () => {
  it('ignores path, query and fragment', () => {
    const keys = [
      'https://host.example/app/',
      'https://host.example/deep/nested/app/',
      'https://host.example/',
    ].map((url) => keyOf(deriveStorageScope({ manifestId: APP_ID, provenance: unsigned(url) })));
    expect(new Set(keys).size).toBe(1);
  });

  it('treats a differing port as a different origin', () => {
    const a = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('http://localhost:5173/a/') }),
    );
    const b = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('http://localhost:5174/a/') }),
    );
    expect(a).not.toBe(b);
  });

  it('treats a differing scheme as a different origin', () => {
    const a = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('http://host.example/a/') }),
    );
    const b = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://host.example/a/') }),
    );
    expect(a).not.toBe(b);
  });

  it('folds host case, because the URL parser already has', () => {
    const upper = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://HOST.example/a/') }),
    );
    const lower = keyOf(
      deriveStorageScope({ manifestId: APP_ID, provenance: unsigned('https://host.example/a/') }),
    );
    expect(upper).toBe(lower);
  });
});

describe('refusals', () => {
  it('refuses a verified identity whose id disagrees with the manifest', () => {
    // Refused, never downgraded to the origin tier. Falling back would turn an
    // internal inconsistency into a route to a weaker namespace -- the
    // downgrade shape Phase 9 step 1 exists to prevent.
    const result = deriveStorageScope({
      manifestId: APP_ID,
      provenance: verified('com.example.other'),
    });
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' });
  });

  it('refuses rather than deriving a namespace from an unparseable base URL', () => {
    const result = deriveStorageScope({
      manifestId: APP_ID,
      provenance: unsigned('not a url'),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-base-url' });
  });

  it('refuses a base URL whose origin serializes to "null"', () => {
    // An opaque origin would otherwise produce the literal namespace
    // `v1:origin:null|<id>`, which every opaque-origin package would share.
    const result = deriveStorageScope({
      manifestId: APP_ID,
      provenance: unsigned('data:text/html,hi'),
    });
    expect(result).toEqual({ ok: false, reason: 'invalid-base-url' });
  });
});

describe('the reserved and legacy namespaces are unreachable', () => {
  it('names the reserved meta prefix under the current scope version', () => {
    expect(RESERVED_META_SCOPE_PREFIX).toBe(`${STORAGE_SCOPE_VERSION}:meta:`);
  });

  it('leaves the legacy namespace as the bare id, with no prefix', () => {
    // Pre-Phase-10 data lives here and nothing writes here afterwards.
    expect(legacyStorageScopeKey(APP_ID)).toBe(APP_ID);
  });

  it('cannot be driven into the reserved or legacy namespace by any legal input', () => {
    // ID_PATTERN admits only [a-z0-9.-], so an id can never contain `:` or
    // `|`, and a serialized origin never contains `|`. That makes the
    // separators unambiguous by construction rather than by convention -- so
    // this sweeps legal ids (including ones that spell the tier names) and
    // asserts no combination escapes its own namespace.
    const ids = [
      'com.example.a',
      'a.b',
      'com.example.with-hyphens',
      'com.example.digits123',
      `com.${'x'.repeat(200)}`,
      'meta.id.origin',
      'v1.meta.migration',
    ];
    const origins = [
      'https://host.example',
      'http://localhost:5173',
      'https://a.b.c.example:8443',
      'http://127.0.0.1:5174',
    ];

    for (const manifestId of ids) {
      const derived = [
        keyOf(deriveStorageScope({ manifestId })),
        keyOf(deriveStorageScope({ manifestId, provenance: verified(manifestId) })),
        ...origins.map((origin) =>
          keyOf(deriveStorageScope({ manifestId, provenance: unsigned(`${origin}/app/`) })),
        ),
      ];

      for (const key of derived) {
        expect(key.startsWith(RESERVED_META_SCOPE_PREFIX)).toBe(false);
        expect(key).not.toBe(legacyStorageScopeKey(manifestId));
        // Every derived key is namespaced; none can be mistaken for a bare id.
        expect(key.startsWith(`${STORAGE_SCOPE_VERSION}:`)).toBe(true);
      }

      // Every tier, and every distinct origin, lands somewhere different.
      expect(new Set(derived).size).toBe(derived.length);
    }
  });
});
