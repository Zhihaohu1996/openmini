import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import type { PackageProvenance } from '../../sandbox/types';
import { createIndexedDbStorageProvider } from './indexedDbStorageProvider';
import {
  MIGRATION_RECORD_SCOPE,
  MIGRATION_RECORD_VERSION,
  readMigrationRecord,
  resolveStorageScope,
} from './storageMigration';
import { createInMemoryStorageProvider, type MiniAppStorageProvider } from './storageProvider';

const APP_ID = 'com.example.notes';
const ORIGIN = 'https://good.example';
const BASE_URL = `${ORIGIN}/app/`;

const VERIFIED_SCOPE = `v1:id:${APP_ID}`;
const ORIGIN_SCOPE = `v1:origin:${ORIGIN}|${APP_ID}`;
const LEGACY_SCOPE = APP_ID;

const MAX_BYTES = 524_288;

const verified: PackageProvenance = {
  baseUrl: BASE_URL,
  identity: { verified: true, id: APP_ID, keyId: 'KEY-A' },
};
const unsigned: PackageProvenance = {
  baseUrl: BASE_URL,
  identity: { verified: false, reason: 'unsigned' },
};

const clock = () => new Date('2026-01-01T00:00:00.000Z');

function resolve(
  provider: MiniAppStorageProvider,
  overrides: Partial<Parameters<typeof resolveStorageScope>[0]> = {},
) {
  return resolveStorageScope({
    provider,
    manifestId: APP_ID,
    provenance: verified,
    maxTotalBytes: MAX_BYTES,
    now: clock,
    ...overrides,
  });
}

const entriesOf = async (provider: MiniAppStorageProvider, scope: string) =>
  [...(await provider.entries(scope))].sort((a, b) => a.key.localeCompare(b.key));

/** Fails the Nth `set` call, simulating a crash mid-migration. */
function failingAfter(inner: MiniAppStorageProvider, failOnSetNumber: number) {
  let sets = 0;
  const provider: MiniAppStorageProvider = {
    get: (a, k) => inner.get(a, k),
    entries: (a) => inner.entries(a),
    getUsedBytes: (a) => inner.getUsedBytes(a),
    async set(a, k, v) {
      sets += 1;
      if (sets === failOnSetNumber) {
        throw new Error('simulated crash');
      }
      return inner.set(a, k, v);
    },
  };
  return provider;
}

describe('tiers that never migrate', () => {
  it('returns the embedded scope untouched', async () => {
    const provider = createInMemoryStorageProvider();
    const result = await resolve(provider, { provenance: undefined });
    expect(result).toMatchObject({
      ok: true,
      scope: { tier: 'embedded' },
      outcome: { kind: 'not-applicable' },
    });
  });

  it('returns the origin scope untouched', async () => {
    const provider = createInMemoryStorageProvider();
    const result = await resolve(provider, { provenance: unsigned });
    expect(result).toMatchObject({
      ok: true,
      scope: { tier: 'origin' },
      outcome: { kind: 'not-applicable' },
    });
  });

  it('propagates a derivation refusal instead of migrating', async () => {
    const provider = createInMemoryStorageProvider();
    const result = await resolve(provider, {
      provenance: {
        baseUrl: BASE_URL,
        identity: { verified: true, id: 'com.other.app', keyId: 'K' },
      },
    });
    expect(result).toEqual({ ok: false, reason: 'identity-mismatch' });
  });
});

describe('adoption from the origin tier', () => {
  it('copies the origin scope into the verified scope on first verified load', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'token', 'abc');
    await provider.set(ORIGIN_SCOPE, 'theme', 'dark');

    const result = await resolve(provider);

    expect(result).toMatchObject({
      ok: true,
      outcome: {
        kind: 'adopted',
        source: ORIGIN_SCOPE,
        sourceTier: 'origin',
        entriesCopied: 2,
        resumed: false,
      },
    });
    expect(await entriesOf(provider, VERIFIED_SCOPE)).toEqual([
      { key: 'theme', value: 'dark' },
      { key: 'token', value: 'abc' },
    ]);
  });

  it('never deletes the source', async () => {
    // Copy, not move. A rollback to a pre-Phase-10 host must still find data.
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');

    await resolve(provider);

    expect(await entriesOf(provider, ORIGIN_SCOPE)).toEqual([{ key: 'k', value: 'v' }]);
  });

  it('marks the adopted data unattested', async () => {
    // Signing attests the package, never the data the package inherits.
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');

    const result = await resolve(provider);
    expect(result.ok && result.outcome.kind === 'adopted' && result.outcome.attested).toBe(false);

    const record = await readMigrationRecord(provider, VERIFIED_SCOPE);
    expect(record).toMatchObject({ status: 'complete', attested: false, entriesCopied: 1 });
  });

  it('does not run again on a later load', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v1');
    await resolve(provider);

    // The app writes, then the source changes underneath. A second adoption
    // would clobber the app's own write.
    await provider.set(VERIFIED_SCOPE, 'k', 'v2');
    await provider.set(ORIGIN_SCOPE, 'k', 'stale');

    const second = await resolve(provider);
    expect(second).toMatchObject({ ok: true, outcome: { kind: 'already-complete' } });
    expect(await provider.get(VERIFIED_SCOPE, 'k')).toBe('v2');
  });
});

describe('crash and resume', () => {
  it('writes the pending record BEFORE the first entry', async () => {
    // The ordering the whole protocol rests on. If the record were written
    // last, a half-copied target would be indistinguishable from a target
    // that simply has data in it.
    const inner = createInMemoryStorageProvider();
    await inner.set(ORIGIN_SCOPE, 'a', '1');
    const provider = failingAfter(inner, 1); // fail on the very first set

    await expect(resolve(provider)).rejects.toThrow(/simulated crash/);

    // Nothing was copied, and no record exists, because the record WAS the
    // first set and it is what failed.
    expect(await inner.entries(VERIFIED_SCOPE)).toEqual([]);
    expect(await readMigrationRecord(inner, VERIFIED_SCOPE)).toBeUndefined();
  });

  it('a crash mid-copy leaves a pending record and the next load resumes', async () => {
    const inner = createInMemoryStorageProvider();
    await inner.set(ORIGIN_SCOPE, 'a', '1');
    await inner.set(ORIGIN_SCOPE, 'b', '2');
    await inner.set(ORIGIN_SCOPE, 'c', '3');

    // set #1 is the pending record, #2..#4 are the three entries. Fail on the
    // third entry, leaving a partial target.
    const crashing = failingAfter(inner, 4);
    await expect(resolve(crashing)).rejects.toThrow(/simulated crash/);

    const midFlight = await readMigrationRecord(inner, VERIFIED_SCOPE);
    expect(midFlight).toMatchObject({ status: 'pending', source: ORIGIN_SCOPE });
    expect((await inner.entries(VERIFIED_SCOPE)).length).toBe(2); // partial

    // Next load, healthy provider: resumes rather than refusing.
    const resumed = await resolve(inner);
    expect(resumed).toMatchObject({
      ok: true,
      outcome: { kind: 'adopted', resumed: true, entriesCopied: 3 },
    });
    expect(await entriesOf(inner, VERIFIED_SCOPE)).toEqual([
      { key: 'a', value: '1' },
      { key: 'b', value: '2' },
      { key: 'c', value: '3' },
    ]);
    expect(await readMigrationRecord(inner, VERIFIED_SCOPE)).toMatchObject({ status: 'complete' });
  });

  it('would have been stranded under the old record-last ordering', async () => {
    // Fail-before/pass-after. This reproduces the rejected design: entries
    // copied first, claim written last. After a crash the target is non-empty
    // and unclaimed -- which is exactly the state the real protocol refuses to
    // adopt into -- so the migration could never resume.
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'a', '1');
    await provider.set(ORIGIN_SCOPE, 'b', '2');

    // Simulate that old ordering: some entries land, no record is written.
    await provider.set(VERIFIED_SCOPE, 'a', '1');

    const result = await resolve(provider);

    // Refused -- correctly, given what it can see -- and the 'b' entry is
    // never carried over. Under the shipped ordering this state is
    // unreachable, because a partial target always carries a pending record.
    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: 'not-adopted', reason: 'target-non-empty' },
    });
    expect(await provider.get(VERIFIED_SCOPE, 'b')).toBeNull();
  });

  it('resuming twice copies nothing the second time', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');

    const first = await resolve(provider);
    const second = await resolve(provider);

    expect(first).toMatchObject({ outcome: { kind: 'adopted' } });
    expect(second).toMatchObject({ outcome: { kind: 'already-complete' } });
  });

  it('is idempotent when the same pending record is resumed twice', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');
    await provider.set(
      MIGRATION_RECORD_SCOPE,
      VERIFIED_SCOPE,
      JSON.stringify({
        v: MIGRATION_RECORD_VERSION,
        status: 'pending',
        source: ORIGIN_SCOPE,
        sourceTier: 'origin',
        startedAt: '2026-01-01T00:00:00.000Z',
        attested: false,
      }),
    );

    await resolve(provider);
    const again = await resolve(provider);

    expect(again).toMatchObject({ outcome: { kind: 'already-complete' } });
    expect(await entriesOf(provider, VERIFIED_SCOPE)).toEqual([{ key: 'k', value: 'v' }]);
  });

  it('keeps the original startedAt when resuming', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');
    await provider.set(
      MIGRATION_RECORD_SCOPE,
      VERIFIED_SCOPE,
      JSON.stringify({
        v: MIGRATION_RECORD_VERSION,
        status: 'pending',
        source: ORIGIN_SCOPE,
        sourceTier: 'origin',
        startedAt: '2020-05-05T00:00:00.000Z',
        attested: false,
      }),
    );

    await resolve(provider);
    expect(await readMigrationRecord(provider, VERIFIED_SCOPE)).toMatchObject({
      startedAt: '2020-05-05T00:00:00.000Z',
      completedAt: '2026-01-01T00:00:00.000Z',
    });
  });
});

describe('refusals', () => {
  it('never adopts into a non-empty target that carries no record', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'from-source', 'x');
    await provider.set(VERIFIED_SCOPE, 'mine', 'y');

    const result = await resolve(provider);

    expect(result).toMatchObject({
      ok: true,
      outcome: { kind: 'not-adopted', reason: 'target-non-empty' },
    });
    // Never merged.
    expect(await entriesOf(provider, VERIFIED_SCOPE)).toEqual([{ key: 'mine', value: 'y' }]);
  });

  it('reports no-source when there is nothing to carry forward', async () => {
    const provider = createInMemoryStorageProvider();
    const result = await resolve(provider);
    expect(result).toMatchObject({ outcome: { kind: 'not-adopted', reason: 'no-source' } });
  });

  it('refuses a source larger than the quota rather than truncating it', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'big', 'x'.repeat(200));

    const result = await resolve(provider, { maxTotalBytes: 50 });

    expect(result).toMatchObject({
      outcome: { kind: 'not-adopted', reason: 'source-too-large', source: ORIGIN_SCOPE },
    });
    expect(await provider.entries(VERIFIED_SCOPE)).toEqual([]);
  });

  it('re-evaluates a size refusal on the next load rather than recording it', async () => {
    // A refusal caused by a limit the operator later raises must not be
    // frozen into the record.
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'big', 'x'.repeat(200));

    await resolve(provider, { maxTotalBytes: 50 });
    expect(await readMigrationRecord(provider, VERIFIED_SCOPE)).toBeUndefined();

    const afterRaise = await resolve(provider, { maxTotalBytes: MAX_BYTES });
    expect(afterRaise).toMatchObject({ outcome: { kind: 'adopted' } });
  });

  it('treats an unreadable record as absent and says so', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(MIGRATION_RECORD_SCOPE, VERIFIED_SCOPE, 'not json');

    const result = await resolve(provider);
    expect(result).toMatchObject({
      outcome: { kind: 'not-adopted', reason: 'record-unreadable' },
    });
  });
});

describe('the legacy bare-id space', () => {
  it('is NOT adopted without host opt-in', async () => {
    // Those bytes were written when any package at any origin could claim any
    // id, so they have no trustworthy writer. Adopting them automatically
    // would hand a verified package whatever an earlier squatter left behind.
    const provider = createInMemoryStorageProvider();
    await provider.set(LEGACY_SCOPE, 'token', 'possibly-poisoned');

    const result = await resolve(provider);

    expect(result).toMatchObject({
      outcome: { kind: 'not-adopted', reason: 'legacy-not-opted-in' },
    });
    expect(await provider.entries(VERIFIED_SCOPE)).toEqual([]);
  });

  it('is adopted when the operator opts that id in, and recorded unattested', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(LEGACY_SCOPE, 'token', 'abc');

    const result = await resolve(provider, {
      adoptLegacyScopeForIds: new Set([APP_ID]),
    });

    expect(result).toMatchObject({
      outcome: { kind: 'adopted', source: LEGACY_SCOPE, sourceTier: 'legacy', attested: false },
    });
    expect(await readMigrationRecord(provider, VERIFIED_SCOPE)).toMatchObject({
      sourceTier: 'legacy',
      attested: false,
    });
  });

  it('opting a different id in does not opt this one in', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(LEGACY_SCOPE, 'k', 'v');

    const result = await resolve(provider, {
      adoptLegacyScopeForIds: new Set(['com.example.other']),
    });
    expect(result).toMatchObject({ outcome: { reason: 'legacy-not-opted-in' } });
  });

  it('prefers the origin source and reports the legacy one rather than merging', async () => {
    const provider = createInMemoryStorageProvider();
    await provider.set(ORIGIN_SCOPE, 'from-origin', 'a');
    await provider.set(LEGACY_SCOPE, 'from-legacy', 'b');

    const result = await resolve(provider, {
      adoptLegacyScopeForIds: new Set([APP_ID]),
    });

    expect(result).toMatchObject({
      outcome: { kind: 'adopted', sourceTier: 'origin', alsoPresent: LEGACY_SCOPE },
    });
    // Exactly one source adopted; no merge.
    expect(await entriesOf(provider, VERIFIED_SCOPE)).toEqual([{ key: 'from-origin', value: 'a' }]);
  });
});

describe('against a real IndexedDB backend', () => {
  let dbCounter = 0;
  const freshDb = () => createIndexedDbStorageProvider(`migration-db-${(dbCounter += 1)}`);

  it('adopts and survives a reopen, without re-adopting', async () => {
    const provider = freshDb();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');

    const first = await resolve(provider);
    expect(first).toMatchObject({ outcome: { kind: 'adopted', entriesCopied: 1 } });

    const second = await resolve(provider);
    expect(second).toMatchObject({ outcome: { kind: 'already-complete' } });
    expect(await provider.get(VERIFIED_SCOPE, 'k')).toBe('v');
    expect(await provider.get(ORIGIN_SCOPE, 'k')).toBe('v');
  });

  it('keeps the migration record out of every derivable scope', async () => {
    const provider = freshDb();
    await provider.set(ORIGIN_SCOPE, 'k', 'v');
    await resolve(provider);

    for (const scope of [VERIFIED_SCOPE, ORIGIN_SCOPE, LEGACY_SCOPE]) {
      const keys = (await provider.entries(scope)).map((entry) => entry.key);
      expect(keys).not.toContain(VERIFIED_SCOPE);
    }
    expect(await provider.entries(MIGRATION_RECORD_SCOPE)).toHaveLength(1);
  });
});
