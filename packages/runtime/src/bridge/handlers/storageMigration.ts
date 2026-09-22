import type { PackageProvenance } from '../../sandbox/types';
import {
  deriveStorageScope,
  legacyStorageScopeKey,
  RESERVED_META_SCOPE_PREFIX,
  type StorageScope,
  type StorageScopeRefusal,
} from './storageScope';
import { sumEntryBytes, type MiniAppStorageProvider } from './storageProvider';

/**
 * Carrying a package's existing data into the namespace its verified identity
 * entitles it to.
 *
 * Phase 9 declined to scope storage on provenance because doing so "would
 * orphan the data of every currently-unsigned package, so it needs a
 * migration story rather than a conditional". This is that story.
 *
 * ## The crash-recovery protocol
 *
 * The provider is documented as non-transactional, so a copy can be
 * interrupted halfway. The whole design turns on one ordering decision:
 *
 * > **The intent record is written BEFORE the first data write.**
 *
 * That is what makes a half-copied target distinguishable from a target that
 * simply has data in it. The tempting alternative — write the claim last, so
 * "a crash leaves no claim and is retried" — cannot work alongside the rule
 * that a non-empty target must never be adopted into: after a crash the
 * target is non-empty and unclaimed, so the next run refuses and the
 * migration is stranded forever. Writing the record first removes the
 * ambiguity instead of trying to resolve it:
 *
 * | Record   | Target    | Means                                   | Action   |
 * |----------|-----------|-----------------------------------------|----------|
 * | absent   | empty     | fresh                                   | migrate  |
 * | absent   | non-empty | app wrote here normally; never migrated | never adopt |
 * | pending  | any       | interrupted                             | resume   |
 * | complete | any       | done                                    | use it   |
 *
 * A partial target *always* carries a `pending` record, so "absent record and
 * non-empty target" can only mean independent data.
 *
 * ## What it will not do
 *
 * - **Never deletes the source.** There is no delete on
 *   `MiniAppStorageProvider` at all. A rollback to a pre-Phase-10 host must
 *   still find its data, which is why this copies rather than moves.
 * - **Never merges.** At most one source is adopted; a second one present is
 *   reported, not combined. Merging two spaces with overlapping keys needs a
 *   conflict rule, and every available conflict rule here is arbitrary.
 * - **Never serves the target until the record says `complete`.** There is no
 *   partial-serving state; callers await the resolution.
 */

/**
 * Where the records live. Reserved: no input to `deriveStorageScope` can
 * produce a key under `v1:meta:`, so no Mini App can read or write here.
 */
export const MIGRATION_RECORD_SCOPE = `${RESERVED_META_SCOPE_PREFIX}migration`;

export const MIGRATION_RECORD_VERSION = 1;

export type MigrationSourceTier = 'origin' | 'legacy';

export interface MigrationRecord {
  readonly v: number;
  readonly status: 'pending' | 'complete';
  /** Scope key the entries came from. */
  readonly source: string;
  readonly sourceTier: MigrationSourceTier;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly entriesCopied?: number;
  /**
   * Always `false`. There is no `true` case, and that is the point.
   *
   * A signature attests the package, never the data the package inherits.
   * The bare-id legacy space in particular is exactly the space the
   * documented id-collision leak let *anyone* write to, so its bytes have no
   * trustworthy writer. The field exists so a record read by an operator
   * says this, rather than requiring them to already know it.
   */
  readonly attested: false;
}

/** Why a migration did not happen. None of these are errors. */
export type NotAdoptedReason =
  | 'no-source'
  | 'target-non-empty'
  | 'source-too-large'
  | 'legacy-not-opted-in'
  | 'record-unreadable';

export type MigrationOutcome =
  | { kind: 'not-applicable' }
  | { kind: 'already-complete' }
  | {
      kind: 'adopted';
      source: string;
      sourceTier: MigrationSourceTier;
      entriesCopied: number;
      resumed: boolean;
      attested: false;
      /** A second candidate source that was present and deliberately left alone. */
      alsoPresent?: string;
    }
  | { kind: 'not-adopted'; reason: NotAdoptedReason; source?: string };

export type ResolveStorageScopeResult =
  | { ok: true; scope: StorageScope; outcome: MigrationOutcome }
  | { ok: false; reason: StorageScopeRefusal };

export interface ResolveStorageScopeOptions {
  provider: MiniAppStorageProvider;
  manifestId: string;
  provenance?: PackageProvenance;
  /** Quota ceiling; a source larger than this is refused rather than truncated. */
  maxTotalBytes: number;
  /**
   * Ids whose bare-id legacy space the host operator has opted into adopting.
   *
   * Empty by default, and that default is the safe one. See
   * `selectSource` for why legacy adoption is not automatic.
   */
  adoptLegacyScopeForIds?: ReadonlySet<string>;
  /** Injected so tests do not depend on wall-clock time. */
  now?: () => Date;
}

function parseRecord(raw: string | null): MigrationRecord | 'unreadable' | undefined {
  if (raw === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return 'unreadable';
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return 'unreadable';
  }
  const record = parsed as Record<string, unknown>;
  if (record.v !== MIGRATION_RECORD_VERSION) {
    return 'unreadable';
  }
  if (record.status !== 'pending' && record.status !== 'complete') {
    return 'unreadable';
  }
  if (typeof record.source !== 'string' || record.source === '') {
    return 'unreadable';
  }
  if (record.sourceTier !== 'origin' && record.sourceTier !== 'legacy') {
    return 'unreadable';
  }
  return record as unknown as MigrationRecord;
}

export async function readMigrationRecord(
  provider: MiniAppStorageProvider,
  targetScope: string,
): Promise<MigrationRecord | 'unreadable' | undefined> {
  return parseRecord(await provider.get(MIGRATION_RECORD_SCOPE, targetScope));
}

async function writeRecord(
  provider: MiniAppStorageProvider,
  targetScope: string,
  record: MigrationRecord,
): Promise<void> {
  await provider.set(MIGRATION_RECORD_SCOPE, targetScope, JSON.stringify(record));
}

/**
 * Chooses what to carry forward, and refuses to guess.
 *
 * Precedence, at most one adopted:
 *
 * 1. **The origin-tier space for the origin this package is being served
 *    from.** Not an attack surface: to be verified you must be signed by a
 *    registered key, and this only ever reads the origin you are actually
 *    served from, so pre-seeding it means already controlling the legitimate
 *    owner's origin. Without this source, "register your id" would mean "lose
 *    your users' data", which discourages exactly the registration that closes
 *    the collision gap.
 *
 * 2. **The bare-id legacy space — only with explicit host opt-in.** This is
 *    deliberately not automatic, and the asymmetry with (1) is the point. The
 *    bare space is the one the documented leak let *any* package at *any*
 *    origin write to. Adopting it automatically would hand a verified package
 *    whatever an earlier squatter left there: the squatter poisons
 *    `com.example.notes`, the real publisher later signs and registers, and
 *    the verified app reads attacker-controlled values as its own. A confused
 *    deputy manufactured by the migration itself. The operator opting in is
 *    asserting "I know who was serving this id before"; nothing in the data
 *    can assert it for them.
 */
async function selectSource(
  provider: MiniAppStorageProvider,
  manifestId: string,
  provenance: PackageProvenance,
  adoptLegacyScopeForIds: ReadonlySet<string>,
): Promise<
  | { picked: { scope: string; tier: MigrationSourceTier }; alsoPresent?: string }
  | { picked: undefined; reason: NotAdoptedReason }
> {
  const originScope = deriveStorageScope({
    manifestId,
    // Ask for the origin-tier key this package *would* have used before it
    // was verified: same URL, unverified identity.
    provenance: { baseUrl: provenance.baseUrl, identity: { verified: false, reason: 'unsigned' } },
  });
  const originKey = originScope.ok ? originScope.scope.key : undefined;
  const legacyKey = legacyStorageScopeKey(manifestId);

  const originHasData = originKey !== undefined && (await provider.entries(originKey)).length > 0;
  const legacyHasData = (await provider.entries(legacyKey)).length > 0;
  const legacyOptedIn = adoptLegacyScopeForIds.has(manifestId);

  if (originHasData && originKey !== undefined) {
    return {
      picked: { scope: originKey, tier: 'origin' },
      // Reported, never merged.
      ...(legacyHasData ? { alsoPresent: legacyKey } : {}),
    };
  }
  if (legacyHasData) {
    return legacyOptedIn
      ? { picked: { scope: legacyKey, tier: 'legacy' } }
      : { picked: undefined, reason: 'legacy-not-opted-in' };
  }
  return { picked: undefined, reason: 'no-source' };
}

/**
 * Copies a source scope into a target, crash-safely.
 *
 * Step order is the contract: the `pending` record is written before the
 * first entry, and `complete` only after the last. A crash anywhere in the
 * middle leaves `pending`, and the next run re-copies the whole source over
 * the target — idempotent, because it overwrites the same keys with the same
 * values.
 */
async function runMigration(
  provider: MiniAppStorageProvider,
  target: string,
  source: { scope: string; tier: MigrationSourceTier },
  existing: MigrationRecord | undefined,
  now: () => Date,
): Promise<number> {
  const startedAt = existing?.startedAt ?? now().toISOString();

  if (existing === undefined) {
    await writeRecord(provider, target, {
      v: MIGRATION_RECORD_VERSION,
      status: 'pending',
      source: source.scope,
      sourceTier: source.tier,
      startedAt,
      attested: false,
    });
  }

  const entries = await provider.entries(source.scope);
  for (const entry of entries) {
    await provider.set(target, entry.key, entry.value);
  }

  await writeRecord(provider, target, {
    v: MIGRATION_RECORD_VERSION,
    status: 'complete',
    source: source.scope,
    sourceTier: source.tier,
    startedAt,
    completedAt: now().toISOString(),
    entriesCopied: entries.length,
    attested: false,
  });

  return entries.length;
}

/**
 * The scope a storage call should use, after any migration it implies.
 *
 * Callers must await this before every read and write, and must not touch the
 * verified scope on their own: the target is only returned once the record
 * says `complete`, which is what keeps "don't switch until the migration is
 * conclusively finished" true rather than aspirational.
 *
 * Only the verified tier can migrate. The origin and embedded tiers are
 * returned immediately — they are where data already is, not where it is
 * going.
 */
export async function resolveStorageScope(
  options: ResolveStorageScopeOptions,
): Promise<ResolveStorageScopeResult> {
  const {
    provider,
    manifestId,
    provenance,
    maxTotalBytes,
    adoptLegacyScopeForIds = new Set<string>(),
    now = () => new Date(),
  } = options;

  const base = deriveStorageScope({ manifestId, provenance });
  if (!base.ok) {
    return base;
  }
  if (base.scope.tier !== 'verified' || provenance === undefined) {
    return { ok: true, scope: base.scope, outcome: { kind: 'not-applicable' } };
  }

  const target = base.scope.key;
  const record = await readMigrationRecord(provider, target);

  if (record !== undefined && record !== 'unreadable') {
    if (record.status === 'complete') {
      return { ok: true, scope: base.scope, outcome: { kind: 'already-complete' } };
    }
    // Interrupted. Resume against the source the record names, not against a
    // freshly selected one — the selection was already made and re-running it
    // could pick differently if the data moved underneath.
    const entriesCopied = await runMigration(
      provider,
      target,
      { scope: record.source, tier: record.sourceTier },
      record,
      now,
    );
    return {
      ok: true,
      scope: base.scope,
      outcome: {
        kind: 'adopted',
        source: record.source,
        sourceTier: record.sourceTier,
        entriesCopied,
        resumed: true,
        attested: false,
      },
    };
  }

  // An unreadable record is treated as absent and reported. The next branch
  // then refuses to adopt into a non-empty target, so a corrupt record can
  // never cause data to be overwritten — it only costs the migration.
  if (record === 'unreadable') {
    return {
      ok: true,
      scope: base.scope,
      outcome: { kind: 'not-adopted', reason: 'record-unreadable' },
    };
  }

  if ((await provider.entries(target)).length > 0) {
    // No record was ever written, so no migration ever began here; this data
    // was written by the app itself in an earlier session. Never adopt into
    // it, and never merge a source with it.
    return {
      ok: true,
      scope: base.scope,
      outcome: { kind: 'not-adopted', reason: 'target-non-empty' },
    };
  }

  const selected = await selectSource(provider, manifestId, provenance, adoptLegacyScopeForIds);
  if (selected.picked === undefined) {
    return {
      ok: true,
      scope: base.scope,
      outcome: { kind: 'not-adopted', reason: selected.reason },
    };
  }

  const sourceEntries = await provider.entries(selected.picked.scope);
  if (sumEntryBytes(sourceEntries) > maxTotalBytes) {
    // Refused rather than truncated, and deliberately not recorded: a refusal
    // caused by a limit the operator later raises should be re-evaluated on
    // the next load, not frozen into the record.
    return {
      ok: true,
      scope: base.scope,
      outcome: {
        kind: 'not-adopted',
        reason: 'source-too-large',
        source: selected.picked.scope,
      },
    };
  }

  const entriesCopied = await runMigration(provider, target, selected.picked, undefined, now);
  return {
    ok: true,
    scope: base.scope,
    outcome: {
      kind: 'adopted',
      source: selected.picked.scope,
      sourceTier: selected.picked.tier,
      entriesCopied,
      resumed: false,
      attested: false,
      ...(selected.alsoPresent ? { alsoPresent: selected.alsoPresent } : {}),
    },
  };
}
