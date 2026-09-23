/**
 * `openmini.trust.json` — the host's trust configuration: which keys may sign
 * which package ids, and which of those keys are still valid.
 *
 * This is the **operator's** document, and that is why it lives here rather
 * than beside the manifest parser. `openmini.json` is written by the Mini App
 * author and travels with the package; `openmini.trust.json` is written by
 * whoever runs the host, and is the one input to the load decision that the
 * package cannot influence. They sit on opposite sides of the trust boundary,
 * so they do not share a package: a schema module holding both would be a
 * standing invitation to share a rule between them, and the rule they must
 * never share is *who gets to decide this*.
 *
 * `@openmini/shared` is the right home for the same reason `integrity.ts` and
 * `csp.ts` are: the browser runtime consumes this format and the Node CLI
 * validates it, and the two have to agree exactly. A config the CLI calls
 * valid and the host then reads differently is worse than no validation at
 * all, because the operator has been told it is fine.
 *
 * Phase 11 W1. Format, types, parser and validator only — nothing here is
 * wired to the load path yet. See docs/plans/phase-11.md.
 */

import { base64ToBytes } from './crypto';

export const TRUST_CONFIG_VERSION = 1;

export const TRUST_CONFIG_FILENAME = 'openmini.trust.json';

/**
 * Whether a registered key may still sign.
 *
 * Two states and no third. There is deliberately no `expired`, and no
 * validity window: an expiry would make the load decision depend on the
 * host's clock, and a clock that is wrong or rolled back would re-admit a key
 * the operator retired. Phase 11 records expiry and timestamping as deferred
 * work rather than approximating them — see docs/plans/phase-11.md.
 *
 * `revoked` is a *retained* state, not a deletion. Removing a compromised key
 * from the list would stop it signing, but it would also erase the record
 * that it was ever trusted, and it would make the refusal indistinguishable
 * from one for a key that was never registered — two situations with
 * different remedies.
 */
export type TrustedKeyStatus = 'active' | 'revoked';

export interface TrustedKeyEntry {
  /**
   * The **complete base64 SPKI public key**, which is the only thing trust is
   * ever decided on. See `keyId` below for the thing it is not.
   */
  readonly publicKey: string;
  /**
   * Required, never inferred. An omitted status in a lifecycle format is
   * ambiguous, and the convenient default — treating it as `active` — would
   * mean a key grants trust because a field was forgotten. The operator says
   * which state a key is in, or the config does not load.
   */
  readonly status: TrustedKeyStatus;
  /**
   * An optional operator-facing label, so a human editing this file can tell
   * two base64 blobs apart.
   *
   * **It never decides trust, and nothing reads it.** It is not checked
   * against `publicKey` either: doing so needs a digest, which would make
   * this validator asynchronous for the sake of a comment field. What
   * protects the decision is not that the label is right — it is that the
   * decision never looks at it.
   */
  readonly keyId?: string;
}

export interface TrustConfigPackageEntry {
  /**
   * The keys registered for this id, active and revoked alike.
   *
   * May be empty. An id present with no keys at all is still **registered** —
   * registration is the presence of the id, which is the host asserting it
   * knows who owns it — so an unsigned package claiming it still fails
   * closed. It reads as "I know who owns this, and nothing may currently sign
   * it", which is the degenerate case of every key being revoked.
   */
  readonly keys: readonly TrustedKeyEntry[];
}

export interface TrustConfig {
  readonly trustConfigVersion: typeof TRUST_CONFIG_VERSION;
  /**
   * Package id → its registered keys.
   *
   * Built with a **null prototype**, so an id spelled `__proto__`,
   * `constructor` or `toString` is an ordinary entry rather than a collision
   * with `Object.prototype`. The manifest's own id grammar would never
   * produce such an id, but this map is assembled from operator-written JSON
   * before any grammar is applied, and a lookup that can reach an inherited
   * member is the class of bug Phase 8.5 R3 hardened the bridge registry
   * against.
   */
  readonly packages: Readonly<Record<string, TrustConfigPackageEntry>>;
}

export type TrustConfigIssueCode =
  | 'MALFORMED_JSON'
  | 'INVALID_ROOT_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_TYPE'
  | 'UNSUPPORTED_TRUST_CONFIG_VERSION'
  | 'INVALID_PACKAGE_ID'
  | 'INVALID_PUBLIC_KEY'
  | 'INVALID_KEY_STATUS'
  | 'INVALID_KEY_ID'
  | 'DUPLICATE_PUBLIC_KEY';

export interface TrustConfigIssue {
  readonly path: string;
  readonly code: TrustConfigIssueCode;
  readonly message: string;
}

export type TrustConfigValidationResult =
  { valid: true; config: TrustConfig } | { valid: false; issues: TrustConfigIssue[] };

const ROOT_FIELDS = ['trustConfigVersion', 'packages'] as const;
const PACKAGE_ENTRY_FIELDS = ['keys'] as const;
const KEY_ENTRY_FIELDS = ['publicKey', 'status', 'keyId'] as const;

const KEY_STATUSES: readonly TrustedKeyStatus[] = ['active', 'revoked'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unknown fields are rejected, exactly as they are in `openmini.sig.json`.
 *
 * The reasoning carries over unchanged: a field this reader drops is a field
 * a future reader enforces, and the gap between them is a configuration one
 * version honours and another silently ignores. For a document whose entire
 * job is to withhold trust, "I did not understand that, so I skipped it" is
 * the wrong instinct.
 */
function collectUnknownFields(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  issues: TrustConfigIssue[],
): void {
  for (const key of Object.keys(value).sort()) {
    if (!allowed.includes(key)) {
      issues.push({
        path: path ? `${path}.${key}` : key,
        code: 'UNKNOWN_FIELD',
        message: `unknown field; allowed here: ${[...allowed].sort().join(', ')}`,
      });
    }
  }
}

/**
 * Structural check only: is this text that could be a base64-encoded key?
 *
 * Deliberately not a check that the bytes *are* a usable P-256 SPKI key. That
 * is proven at verification time, where the key is actually imported, and
 * duplicating it here would tie this format to one algorithm for no gain: a
 * `publicKey` that is not the signer's key simply never matches it, and the
 * load fails closed.
 */
function isDecodableBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  try {
    base64ToBytes(value);
    return true;
  } catch {
    return false;
  }
}

function validateKeyEntry(
  value: unknown,
  path: string,
  issues: TrustConfigIssue[],
): TrustedKeyEntry | undefined {
  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'INVALID_TYPE',
      message: 'must be an object with "publicKey" and "status"',
    });
    return undefined;
  }

  collectUnknownFields(value, KEY_ENTRY_FIELDS, path, issues);

  let usable = true;

  const publicKey = value.publicKey;
  if (!('publicKey' in value)) {
    issues.push({ path: `${path}.publicKey`, code: 'MISSING_FIELD', message: 'is required' });
    usable = false;
  } else if (typeof publicKey !== 'string') {
    issues.push({
      path: `${path}.publicKey`,
      code: 'INVALID_TYPE',
      message: 'must be a string',
    });
    usable = false;
  } else if (!isDecodableBase64(publicKey)) {
    issues.push({
      path: `${path}.publicKey`,
      code: 'INVALID_PUBLIC_KEY',
      message: 'must be the complete base64-encoded SPKI public key',
    });
    usable = false;
  }

  const status = value.status;
  if (!('status' in value)) {
    issues.push({
      path: `${path}.status`,
      code: 'MISSING_FIELD',
      message: `is required and is never inferred; write one of: ${KEY_STATUSES.join(', ')}`,
    });
    usable = false;
  } else if (typeof status !== 'string' || !KEY_STATUSES.includes(status as TrustedKeyStatus)) {
    issues.push({
      path: `${path}.status`,
      code: 'INVALID_KEY_STATUS',
      message: `must be one of: ${KEY_STATUSES.join(', ')}`,
    });
    usable = false;
  }

  const keyId = value.keyId;
  if ('keyId' in value && (typeof keyId !== 'string' || keyId.length === 0)) {
    issues.push({
      path: `${path}.keyId`,
      code: 'INVALID_KEY_ID',
      message: 'must be a non-empty string when present (a label only; it never decides trust)',
    });
    usable = false;
  }

  if (!usable) return undefined;

  const entry: TrustedKeyEntry = {
    publicKey: publicKey as string,
    status: status as TrustedKeyStatus,
  };
  return typeof keyId === 'string' ? { ...entry, keyId } : entry;
}

function validatePackageEntry(
  id: string,
  value: unknown,
  issues: TrustConfigIssue[],
): TrustConfigPackageEntry | undefined {
  const path = `packages[${JSON.stringify(id)}]`;

  if (id.length === 0) {
    issues.push({
      path: 'packages',
      code: 'INVALID_PACKAGE_ID',
      message: 'a package id must not be empty',
    });
    return undefined;
  }

  if (!isPlainObject(value)) {
    issues.push({
      path,
      code: 'INVALID_TYPE',
      message: 'must be an object with a "keys" array',
    });
    return undefined;
  }

  collectUnknownFields(value, PACKAGE_ENTRY_FIELDS, path, issues);

  if (!('keys' in value)) {
    issues.push({ path: `${path}.keys`, code: 'MISSING_FIELD', message: 'is required' });
    return undefined;
  }
  if (!Array.isArray(value.keys)) {
    issues.push({ path: `${path}.keys`, code: 'INVALID_TYPE', message: 'must be an array' });
    return undefined;
  }

  const keys: TrustedKeyEntry[] = [];
  const seen = new Set<string>();

  value.keys.forEach((raw, index) => {
    const entry = validateKeyEntry(raw, `${path}.keys[${index}]`, issues);
    if (!entry) return;
    if (seen.has(entry.publicKey)) {
      // One key, two states, no way to tell which the operator meant. A
      // reader that picked either would be picking for them.
      issues.push({
        path: `${path}.keys[${index}].publicKey`,
        code: 'DUPLICATE_PUBLIC_KEY',
        message: 'this public key is already listed for this id; it cannot hold two statuses',
      });
      return;
    }
    seen.add(entry.publicKey);
    keys.push(entry);
  });

  return { keys };
}

/**
 * Validates an already-parsed trust configuration.
 *
 * Every issue is collected rather than the first one returned, because this
 * is an operator-authored document: somebody editing it by hand wants the
 * whole list, the way `validateManifest` gives an author the whole list. That
 * is the opposite of `integrity.ts`, which stops at the first failure — and
 * rightly, since the thing it reads was written by whoever it is checking.
 *
 * **Nothing is registered unless everything validates.** There is no partial
 * config: a file with one bad entry does not quietly register the other
 * entries, because the operator's intent for the whole file is in doubt and
 * "most of your trust configuration applied" is not a state anyone should
 * have to reason about.
 *
 * Package ids are not checked against the manifest's id grammar. That grammar
 * lives in `@openmini/manifest`, which this package must not depend on, and
 * copying it here would create a second copy free to drift from the first.
 * Nothing is lost by the omission: an id no manifest could ever declare
 * simply never matches one, so it registers nothing and fails closed. The
 * grammar would not have caught the mistake that actually happens either — a
 * typo that is still a well-formed id.
 */
export function validateTrustConfig(input: unknown): TrustConfigValidationResult {
  if (!isPlainObject(input)) {
    return {
      valid: false,
      issues: [
        {
          path: '',
          code: 'INVALID_ROOT_TYPE',
          message: `${TRUST_CONFIG_FILENAME} must be a JSON object`,
        },
      ],
    };
  }

  const issues: TrustConfigIssue[] = [];
  collectUnknownFields(input, ROOT_FIELDS, '', issues);

  if (!('trustConfigVersion' in input)) {
    issues.push({ path: 'trustConfigVersion', code: 'MISSING_FIELD', message: 'is required' });
  } else if (input.trustConfigVersion !== TRUST_CONFIG_VERSION) {
    // Refused, not best-effort parsed — the same call `parseSignatureEnvelope`
    // makes about `sigVersion`, for the same reason.
    issues.push({
      path: 'trustConfigVersion',
      code: 'UNSUPPORTED_TRUST_CONFIG_VERSION',
      message: `unsupported trustConfigVersion ${JSON.stringify(input.trustConfigVersion)}; only ${TRUST_CONFIG_VERSION} is supported`,
    });
  }

  const packages = Object.create(null) as Record<string, TrustConfigPackageEntry>;

  if (!('packages' in input)) {
    issues.push({ path: 'packages', code: 'MISSING_FIELD', message: 'is required' });
  } else if (!isPlainObject(input.packages)) {
    issues.push({
      path: 'packages',
      code: 'INVALID_TYPE',
      message: 'must be an object mapping package ids to their registered keys',
    });
  } else {
    for (const [id, entry] of Object.entries(input.packages)) {
      const validated = validatePackageEntry(id, entry, issues);
      if (validated) {
        packages[id] = validated;
      }
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  return { valid: true, config: { trustConfigVersion: TRUST_CONFIG_VERSION, packages } };
}

/** Parses and validates `openmini.trust.json` text. */
export function parseTrustConfig(raw: string): TrustConfigValidationResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      issues: [{ path: '', code: 'MALFORMED_JSON', message: `invalid JSON: ${detail}` }],
    };
  }
  return validateTrustConfig(parsed);
}

/**
 * Renders issues for a human.
 *
 * Shared so that `openmini trust validate` and the host print the same text
 * about the same file — an operator comparing a CLI run against what the host
 * reported should not have to work out whether two different wordings mean
 * the same thing.
 */
export function formatTrustConfigIssues(issues: readonly TrustConfigIssue[]): string {
  const lines = issues.map((issue) =>
    issue.path ? `- ${issue.path}: ${issue.message}` : `- ${issue.message}`,
  );
  return [`Invalid ${TRUST_CONFIG_FILENAME}:`, ...lines].join('\n');
}
