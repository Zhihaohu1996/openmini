import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
} from '@openmini/shared';
import type { SigningKeyPair, TrustedKeyEntry } from '@openmini/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPackage } from '../sandbox/packageVerification';
import type { PackageTrustStore } from '../sandbox/packageVerification';
import { resolveStorageScope } from './handlers/storageMigration';
import { readMigrationRecord } from './handlers/storageMigration';
import {
  createInMemoryStorageProvider,
  type MiniAppStorageProvider,
} from './handlers/storageProvider';
import { deriveStorageScope, legacyStorageScopeKey } from './handlers/storageScope';

/**
 * Where the trust lifecycle meets the storage namespace.
 *
 * Phase 11 W3 made a revoked key refuse the load; this file is about what
 * that means for the data the package already wrote, and about the property
 * rotation depends on — that the verified namespace names the id and never
 * the signing key.
 *
 * Deliberately an integration test rather than a unit one. Both claims are
 * about a *chain*: real key material, a real signature, the real trust
 * decision, the real derivation and a real provider. A test that constructed
 * a `PackageProvenance` by hand would be asserting that the derivation is
 * stable under an input it was handed, which is not the claim. The claim is
 * that rotating a key produces the same namespace, and that a revoked one
 * produces no namespace at all — and only the whole chain can say that.
 *
 * No production code accompanies this file. See docs/plans/phase-11.md, W4.
 */

const ORIGIN = 'https://cdn.example.com';
const BASE_URL = `${ORIGIN}/apps/notes/`;
const APP_ID = 'com.example.notes';
const OTHER_ID = 'com.example.other';
const APP_VERSION = '1.0.0';
const MAX_BYTES = 524_288;

const VERIFIED_SCOPE = `v1:id:${APP_ID}`;
const ORIGIN_SCOPE = `v1:origin:${ORIGIN}|${APP_ID}`;

const ENTRY_DIGEST = 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';

const manifestFor = (id: string): Uint8Array =>
  new TextEncoder().encode(
    JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Notes',
      version: APP_VERSION,
      entry: 'index.html',
      permissions: ['storage'],
    }),
  );

const clock = () => new Date('2026-01-01T00:00:00.000Z');

/** The key the app shipped with, and the one it rotates to. */
let original: SigningKeyPair;
let successor: SigningKeyPair;

beforeAll(async () => {
  original = await generateSigningKeyPair();
  successor = await generateSigningKeyPair();
});

async function signature(key: SigningKeyPair, id = APP_ID): Promise<string> {
  const envelope = await signIntegrityPayload(
    {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id,
      version: APP_VERSION,
      files: {
        'openmini.json': await sha256Base64(manifestFor(id)),
        'index.html': ENTRY_DIGEST,
      },
    },
    key.privateKey,
    key.publicKeySpki,
  );
  return serializeSignatureEnvelope(envelope);
}

const keyOf = (key: SigningKeyPair): string => bytesToBase64(key.publicKeySpki);
const active = (key: SigningKeyPair): TrustedKeyEntry => ({
  publicKey: keyOf(key),
  status: 'active',
});
const revoked = (key: SigningKeyPair): TrustedKeyEntry => ({
  publicKey: keyOf(key),
  status: 'revoked',
});

/** Before rotation: one key, active. */
const beforeRotation = (): PackageTrustStore => ({ [APP_ID]: [active(original)] });

/**
 * After rotation: the successor signs, the original is retired but retained.
 *
 * Retained rather than deleted, because deleting it would make a package
 * still signed by it indistinguishable from one signed by a key nobody ever
 * registered — the same remedy-shaped distinction W3 gave a code to.
 */
const afterRotation = (): PackageTrustStore => ({
  [APP_ID]: [revoked(original), active(successor)],
});

/**
 * The real chain: verify, then resolve the scope that verification entitles
 * the package to. A refusal stops before the resolution, which is itself one
 * of the things under test.
 */
async function loadAndResolve(
  provider: MiniAppStorageProvider,
  trustStore: PackageTrustStore,
  signer: SigningKeyPair,
  options: { manifestId?: string } = {},
) {
  const manifestId = options.manifestId ?? APP_ID;
  const outcome = await verifyPackage({
    baseUrl: BASE_URL,
    manifestId,
    manifestVersion: APP_VERSION,
    manifestBytes: manifestFor(manifestId),
    signatureText: await signature(signer, manifestId),
    trustStore,
  });

  if (!outcome.ok) {
    return { verification: outcome, resolved: undefined } as const;
  }

  const resolved = await resolveStorageScope({
    provider,
    manifestId,
    provenance: outcome.provenance,
    maxTotalBytes: MAX_BYTES,
    now: clock,
  });
  return { verification: outcome, resolved } as const;
}

const entryKeys = async (provider: MiniAppStorageProvider, scope: string) =>
  (await provider.entries(scope)).map((entry) => entry.key).sort();

describe('rotation continuity: the verified namespace survives a key change', () => {
  it('derives the same scope key before and after rotation', async () => {
    const provider = createInMemoryStorageProvider();

    const before = await loadAndResolve(provider, beforeRotation(), original);
    const after = await loadAndResolve(provider, afterRotation(), successor);

    expect(before.resolved).toMatchObject({ ok: true });
    expect(after.resolved).toMatchObject({ ok: true });
    if (!before.resolved?.ok || !after.resolved?.ok) return;

    expect(before.resolved.scope.key).toBe(VERIFIED_SCOPE);
    expect(after.resolved.scope.key).toBe(before.resolved.scope.key);
    expect(after.resolved.scope.tier).toBe('verified');
  });

  it('rotates to a genuinely different key, so the previous assertion means something', async () => {
    // Guards the test above against passing for the wrong reason. If both
    // loads were signed by one key there would be no rotation to survive.
    const before = await loadAndResolve(
      createInMemoryStorageProvider(),
      beforeRotation(),
      original,
    );
    const after = await loadAndResolve(createInMemoryStorageProvider(), afterRotation(), successor);

    expect(before.verification.ok).toBe(true);
    expect(after.verification.ok).toBe(true);
    if (!before.verification.ok || !after.verification.ok) return;

    const beforeIdentity = before.verification.provenance.identity;
    const afterIdentity = after.verification.provenance.identity;
    expect(beforeIdentity.verified).toBe(true);
    expect(afterIdentity.verified).toBe(true);
    if (!beforeIdentity.verified || !afterIdentity.verified) return;

    expect(afterIdentity.keyId).not.toBe(beforeIdentity.keyId);
    expect(afterIdentity.id).toBe(beforeIdentity.id);
  });

  it('never names either keyId in the namespace it derives', async () => {
    // Invariant 4, stated directly rather than inferred from the two keys
    // happening to agree. `identity.keyId` is in the type and reaching for
    // it looks natural; the namespace must not contain it.
    const provider = createInMemoryStorageProvider();
    const after = await loadAndResolve(provider, afterRotation(), successor);

    expect(after.resolved?.ok).toBe(true);
    if (!after.resolved?.ok) return;

    expect(after.resolved.scope.key).not.toContain(original.keyId);
    expect(after.resolved.scope.key).not.toContain(successor.keyId);
    expect(after.resolved.scope.key).toBe(VERIFIED_SCOPE);
  });

  it('reads back data written under the old key after rotating to the new one', async () => {
    // The property an operator actually depends on. If this failed, routine
    // key hygiene would be a data-loss event, which is how you get operators
    // who never rotate.
    const provider = createInMemoryStorageProvider();

    const before = await loadAndResolve(provider, beforeRotation(), original);
    expect(before.resolved?.ok).toBe(true);
    if (!before.resolved?.ok) return;
    await provider.set(before.resolved.scope.key, 'draft', 'written under the original key');

    const after = await loadAndResolve(provider, afterRotation(), successor);
    expect(after.resolved?.ok).toBe(true);
    if (!after.resolved?.ok) return;

    expect(await provider.get(after.resolved.scope.key, 'draft')).toBe(
      'written under the original key',
    );
  });

  it('copies nothing across the rotation, because there is nowhere to copy from or to', async () => {
    // Continuity here is the *absence* of a migration, not a successful one.
    // The second load finds its own data already in the target, so it adopts
    // nothing and no record is written.
    const provider = createInMemoryStorageProvider();

    const before = await loadAndResolve(provider, beforeRotation(), original);
    expect(before.resolved).toMatchObject({
      ok: true,
      outcome: { kind: 'not-adopted', reason: 'no-source' },
    });
    if (!before.resolved?.ok) return;
    await provider.set(before.resolved.scope.key, 'draft', 'written under the original key');

    const after = await loadAndResolve(provider, afterRotation(), successor);
    expect(after.resolved).toMatchObject({
      ok: true,
      outcome: { kind: 'not-adopted', reason: 'target-non-empty' },
    });

    expect(await readMigrationRecord(provider, VERIFIED_SCOPE)).toBeUndefined();
    expect(await entryKeys(provider, VERIFIED_SCOPE)).toEqual(['draft']);
  });

  it('keeps serving the rotated app from the verified tier, not the origin tier', async () => {
    const provider = createInMemoryStorageProvider();
    const after = await loadAndResolve(provider, afterRotation(), successor);

    expect(after.resolved?.ok).toBe(true);
    if (!after.resolved?.ok) return;
    expect(after.resolved.scope.tier).toBe('verified');
    expect(after.resolved.scope.key).not.toBe(ORIGIN_SCOPE);
  });
});

describe('a revoked id is never an adoption source, and never adopts', () => {
  /** Seeds the origin-tier space an unverified package would have written to. */
  const seedOriginTier = async (provider: MiniAppStorageProvider) => {
    await provider.set(ORIGIN_SCOPE, 'carried', 'origin-tier data');
  };

  it('adopts the origin-tier data when the signing key is active', async () => {
    // The control. Without it the revoked case below could pass because
    // migration never runs at all, rather than because the load is refused.
    const provider = createInMemoryStorageProvider();
    await seedOriginTier(provider);

    const loaded = await loadAndResolve(provider, beforeRotation(), original);

    expect(loaded.resolved).toMatchObject({
      ok: true,
      outcome: { kind: 'adopted', source: ORIGIN_SCOPE, sourceTier: 'origin', entriesCopied: 1 },
    });
    expect(await provider.get(VERIFIED_SCOPE, 'carried')).toBe('origin-tier data');
  });

  it('runs no migration at all when that same key is revoked', async () => {
    // Same provider state, same key, one field different. The adoption the
    // control just performed does not happen: the load is refused before a
    // scope exists to adopt into, so the verified namespace stays empty and
    // no record is written.
    const provider = createInMemoryStorageProvider();
    await seedOriginTier(provider);

    const loaded = await loadAndResolve(provider, { [APP_ID]: [revoked(original)] }, original);

    expect(loaded.verification).toMatchObject({ ok: false, code: 'revoked-key' });
    expect(loaded.resolved).toBeUndefined();
    expect(await entryKeys(provider, VERIFIED_SCOPE)).toEqual([]);
    expect(await readMigrationRecord(provider, VERIFIED_SCOPE)).toBeUndefined();
  });

  it('leaves the source space exactly as it found it', async () => {
    // Revocation refuses a load; it does not touch data. There is no delete
    // on the provider and this phase does not add one — the data becomes
    // unreachable, which is the Phase 10 position held rather than revisited.
    const provider = createInMemoryStorageProvider();
    await seedOriginTier(provider);

    await loadAndResolve(provider, { [APP_ID]: [revoked(original)] }, original);

    expect(await provider.get(ORIGIN_SCOPE, 'carried')).toBe('origin-tier data');
  });

  it('produces no provenance, so no scope can be derived from the refusal', async () => {
    // The structural reason the assertions above hold. `resolveStorageScope`
    // reaches the verified tier only through a verified provenance, and a
    // refusal carries none — so there is no value a caller could pass on.
    const provider = createInMemoryStorageProvider();
    const loaded = await loadAndResolve(provider, { [APP_ID]: [revoked(original)] }, original);

    expect(loaded.verification.ok).toBe(false);
    expect(loaded.verification).not.toHaveProperty('provenance');

    // And the fallback a caller would reach for if it ignored the refusal is
    // the embedded bare-id tier, which is not the verified namespace.
    expect(deriveStorageScope({ manifestId: APP_ID })).toEqual({
      ok: true,
      scope: { key: legacyStorageScopeKey(APP_ID), tier: 'embedded' },
    });
  });

  it('does not let a revoked id strand its data into another id', async () => {
    // The verified space of one id is not in any other id's candidate source
    // set. `selectSource` considers the serving origin's space and the bare
    // legacy space, and nothing else — least of all another `v1:id:` key.
    const provider = createInMemoryStorageProvider();
    await provider.set(VERIFIED_SCOPE, 'secret', 'belongs to the revoked id');

    const other = await loadAndResolve(
      provider,
      { [APP_ID]: [revoked(original)], [OTHER_ID]: [active(successor)] },
      successor,
      { manifestId: OTHER_ID },
    );

    expect(other.resolved).toMatchObject({
      ok: true,
      outcome: { kind: 'not-adopted', reason: 'no-source' },
    });
    if (!other.resolved?.ok) return;
    expect(other.resolved.scope.key).toBe(`v1:id:${OTHER_ID}`);
    expect(await entryKeys(provider, `v1:id:${OTHER_ID}`)).toEqual([]);
  });

  it('restores access when the id is registered again under a new key', async () => {
    // Revocation strands data; it does not destroy it. Rotating forward is
    // the remedy, and it works because the namespace named the id all along.
    const provider = createInMemoryStorageProvider();

    const before = await loadAndResolve(provider, beforeRotation(), original);
    expect(before.resolved?.ok).toBe(true);
    await provider.set(VERIFIED_SCOPE, 'draft', 'written before the compromise');

    const whileRevoked = await loadAndResolve(
      provider,
      { [APP_ID]: [revoked(original)] },
      original,
    );
    expect(whileRevoked.verification).toMatchObject({ ok: false, code: 'revoked-key' });

    const recovered = await loadAndResolve(provider, afterRotation(), successor);
    expect(recovered.resolved?.ok).toBe(true);
    if (!recovered.resolved?.ok) return;
    expect(recovered.resolved.scope.key).toBe(VERIFIED_SCOPE);
    expect(await provider.get(VERIFIED_SCOPE, 'draft')).toBe('written before the compromise');
  });

  it('does not adopt the bare legacy space for a revoked id, opted in or not', async () => {
    // The legacy space is the one the documented id-collision leak let any
    // package write to. A revoked key must not be the thing that launders it
    // into the verified tier, and the opt-in must not change that: the load
    // never happens, so the opt-in is never consulted.
    const provider = createInMemoryStorageProvider();
    await provider.set(legacyStorageScopeKey(APP_ID), 'squatted', 'left by someone else');

    const loaded = await loadAndResolve(provider, { [APP_ID]: [revoked(original)] }, original);

    expect(loaded.verification).toMatchObject({ ok: false, code: 'revoked-key' });
    expect(await entryKeys(provider, VERIFIED_SCOPE)).toEqual([]);
  });
});
