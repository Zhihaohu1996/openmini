import type { PackageProvenance } from '../../sandbox/types';

/**
 * Which storage namespace a Mini App's data lives in.
 *
 * Until Phase 10 every read and write was keyed on `manifest.id` alone, and
 * `manifest.id` is self-asserted: two packages served from anywhere at all
 * could claim one id and share one store. That was the limitation
 * docs/security/bridge.md carried from Phase 4/5 onward, and Phase 9 narrowed
 * without closing -- it made a *registered* id unreachable by an impostor, but
 * left every unregistered id exactly as exposed as before.
 *
 * This module is the derivation that closes it. It is deliberately pure: no
 * provider, no I/O, no migration. It answers one question -- given who this
 * package turned out to be, which namespace is it entitled to? -- so that the
 * answer can be reviewed and tested on its own, before anything depends on it.
 */

/**
 * The three namespaces a package can be entitled to, and why they differ.
 *
 * - `verified` -- the host registered this id and the package proved it holds
 *   a registered key. The id is exclusively owned, so the id alone is a safe
 *   namespace.
 * - `origin` -- identity was not established. The only thing that can
 *   distinguish two packages claiming one id is where they were served from.
 * - `embedded` -- no package load happened at all (a static fixture, a test).
 *   There is nobody to be isolated from.
 */
export type StorageTier = 'verified' | 'origin' | 'embedded';

/**
 * Namespace prefixes carry a format version for the same reason `sigVersion`,
 * `payloadVersion` and `schemaVersion` do: if a later phase changes the
 * derivation -- per-user partitioning, say -- it needs a fresh namespace and
 * its own adoption rule, and a version prefix is what lets the two coexist
 * without either having to guess what the other meant.
 */
export const STORAGE_SCOPE_VERSION = 'v1';

const VERIFIED_PREFIX = `${STORAGE_SCOPE_VERSION}:id:`;
const ORIGIN_PREFIX = `${STORAGE_SCOPE_VERSION}:origin:`;
const EMBEDDED_PREFIX = `${STORAGE_SCOPE_VERSION}:embedded:`;

/**
 * Host bookkeeping -- the migration record lives here.
 *
 * Reserved means unreachable: no input to `deriveStorageScope` can produce a
 * key under this prefix, because every derived key starts with one of the
 * three prefixes above. That is a property of the derivation, not a
 * convention, and a fuzz test pins it.
 */
export const RESERVED_META_SCOPE_PREFIX = `${STORAGE_SCOPE_VERSION}:meta:`;

export interface StorageScope {
  readonly key: string;
  readonly tier: StorageTier;
}

/**
 * Why a derivation can refuse.
 *
 * `identity-mismatch` is the important one. `verifyPackage` already asserts
 * `payload.id === manifestId` before it produces a verified identity, so the
 * two values reaching a handler through separate parameters must agree. If
 * they ever do not, something between the loader and here is wrong, and the
 * only safe answer is to refuse -- see `deriveStorageScope`.
 */
export type StorageScopeRefusal = 'identity-mismatch' | 'invalid-base-url';

export type DeriveStorageScopeResult =
  { ok: true; scope: StorageScope } | { ok: false; reason: StorageScopeRefusal };

/**
 * The namespace pre-Phase-10 data sits in: the bare `manifest.id`, with no
 * prefix at all.
 *
 * Nothing writes here after Phase 10. It is readable only as a migration
 * source, and only under the rules in `storageMigration.ts` -- the bytes in it
 * were written when any package could claim any id, so they have no
 * trustworthy writer.
 */
export function legacyStorageScopeKey(manifestId: string): string {
  return manifestId;
}

/**
 * Decides which namespace a package may use.
 *
 * Three rules, each of which exists to prevent a specific mistake:
 *
 * **The verified namespace names the id, never the `keyId`.** A trust store
 * entry is an *array* of acceptable keys (see `packageVerification.ts`)
 * precisely because key rotation means two keys are valid at once. If the
 * namespace named the signing key, rotating a key would move an app's data --
 * turning routine key hygiene into a data-loss event, which is how you get
 * operators who never rotate. `identity.keyId` is right there in the type and
 * reaching for it looks natural; do not.
 *
 * **An unverified package is scoped by origin, not by package path.** Anyone
 * who can publish at `https://host/evil/` can publish at `https://host/app/`,
 * so a path buys no isolation, while it does break any app that moves from
 * `/app/` to `/app/v2/`. The surviving consequence -- two unsigned packages at
 * the same origin sharing an id still share a store -- is real, documented,
 * and pinned by a test. They are already mutually trusting.
 *
 * **`untrusted-key` is treated exactly as `unsigned`.** Scoping a signed-but-
 * untrusted package by its signing key is tempting, because its data would
 * then follow it between origins. It is also storage trust-on-first-use: the
 * first key to claim an id would own that namespace forever, decided by
 * nobody. Phase 9 lists "no trust on first use" as a non-goal, and this is
 * that, wearing a different hat.
 */
export function deriveStorageScope(input: {
  manifestId: string;
  provenance?: PackageProvenance;
}): DeriveStorageScopeResult {
  const { manifestId, provenance } = input;

  if (provenance === undefined) {
    return { ok: true, scope: { key: `${EMBEDDED_PREFIX}${manifestId}`, tier: 'embedded' } };
  }

  if (provenance.identity.verified) {
    // Refused, not downgraded. Falling back to the origin tier here would
    // turn an internal inconsistency into a route to a weaker namespace --
    // exactly the downgrade shape Phase 9's step 1 exists to prevent, where a
    // failed check must never become a cheaper path.
    if (provenance.identity.id !== manifestId) {
      return { ok: false, reason: 'identity-mismatch' };
    }
    return { ok: true, scope: { key: `${VERIFIED_PREFIX}${manifestId}`, tier: 'verified' } };
  }

  let origin: string;
  try {
    origin = new URL(provenance.baseUrl).origin;
  } catch {
    return { ok: false, reason: 'invalid-base-url' };
  }
  // `normalizePackageBaseUrl` already guarantees a well-formed http(s) URL, so
  // this cannot fail on the real load path. It is checked anyway because this
  // function is exported and pure: a caller that hands it a bad value should
  // get a refusal, not a namespace derived from the string "null".
  if (origin === 'null') {
    return { ok: false, reason: 'invalid-base-url' };
  }

  // Exactly one `|` appears in an origin-tier key, and it is this one.
  // `ID_PATTERN` admits only [a-z0-9.-], so an id can never contain `:` or
  // `|`; a serialized origin never contains `|`. The separator is therefore
  // unambiguous by construction rather than by convention.
  return {
    ok: true,
    scope: { key: `${ORIGIN_PREFIX}${origin}|${manifestId}`, tier: 'origin' },
  };
}
