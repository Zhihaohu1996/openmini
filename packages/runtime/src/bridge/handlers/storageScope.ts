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
 *   There is nobody to be isolated from, and its key is the **bare
 *   `manifestId`**: exactly where it was before Phase 10. See
 *   `legacyStorageScopeKey`.
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

/**
 * Host bookkeeping -- the migration record lives here.
 *
 * Reserved means unreachable: no input to `deriveStorageScope` can produce a
 * key under this prefix, because a derived key is either prefixed `v1:id:` /
 * `v1:origin:` or is a bare `manifestId`, and `ID_PATTERN` forbids `:` in an
 * id. That is a property of the derivation, not a convention, and a fuzz test
 * pins it.
 *
 * Note this is the *only* unreachable space. The bare-id space is
 * deliberately reachable, by the `embedded` tier — see
 * `legacyStorageScopeKey`.
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
 * The bare `manifest.id`, with no prefix at all.
 *
 * This is where **all** storage lived before Phase 10, and it is still where
 * the `embedded` tier lives — deliberately. Moving the embedded tier to a
 * prefixed namespace would have silently orphaned the existing IndexedDB
 * contents of every host that renders static fixtures, for no benefit: a
 * package loaded from a URL always carries provenance, so it can never reach
 * this key, and a package with no provenance was never isolated from another
 * with the same id anyway. Phase 10 is supposed to leave that path exactly
 * where it was, so it does.
 *
 * The same key is therefore also the *legacy* migration source: for a
 * remotely-loaded package that predates Phase 10, its data is here. Reading
 * it as a source is gated behind an explicit per-id host opt-in, because the
 * bytes here were written when any package could claim any id and so have no
 * trustworthy writer. See `storageMigration.ts`.
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
    // The bare id, unchanged from before Phase 10. Expressed through the
    // legacy helper rather than repeating the expression, because the two
    // being the same key is the point rather than a coincidence.
    return { ok: true, scope: { key: legacyStorageScopeKey(manifestId), tier: 'embedded' } };
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
