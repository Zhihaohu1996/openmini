import { bytesToBase64, digestsEqual, sha256Base64, verifySignatureFile } from '@openmini/shared';
import type { TrustConfig, TrustedKeyEntry } from '@openmini/shared';
import type { PackageProvenance } from './types';

/**
 * Deciding what a package is, and whether to run it.
 *
 * Kept free of `fetch` so the whole decision table can be tested directly on
 * values. `loadMiniAppFromUrl` does the network work and calls in here.
 */

/**
 * Which keys may sign which package ids.
 *
 * Keyed by `manifest.id` and holding **complete base64 SPKI public keys**,
 * never keyIds. A keyId is a label an attacker can copy; only the key
 * material is the anchor. That holds for the richer entry form too: a
 * `TrustedKeyEntry` may carry a `keyId` for a human reading the host's
 * configuration, and nothing in this module ever reads it.
 * See @openmini/shared's integrity and trustConfig modules.
 *
 * An id present here is *registered*: the host is asserting it knows who
 * owns that id. That assertion is what makes fail-closed possible, and it is
 * the only thing that does.
 */
export type PackageTrustStore = Readonly<Record<string, readonly PackageTrustEntry[]>>;

/**
 * One registered key, in either of the two spellings a host may use.
 *
 * A bare `string` is the **legacy** form: the complete base64 SPKI key and
 * nothing else, which is what this store held before Phase 11. It still
 * means exactly what it meant then — a key that may sign — and
 * `normalizeTrustEntry` is where that is written down once.
 *
 * Supporting it is not a grace period with an expiry attached. Phase 11
 * deliberately does not set the point at which the legacy form is deprecated
 * or removed; that belongs to whichever later phase first has a reason to
 * force it. Until then this is a supported spelling, not a tolerated one.
 * See docs/plans/phase-11.md.
 */
export type PackageTrustEntry = string | TrustedKeyEntry;

/**
 * Resolves either spelling to the full entry form.
 *
 * A bare string becomes `active`, which is the whole of the backward
 * compatibility story: before Phase 11 there was no way to register a key
 * except as one that may sign, so that is what a legacy entry must continue
 * to mean. Note the asymmetry with the trust *config* file, where an omitted
 * `status` is rejected rather than defaulted — there the operator is writing
 * a lifecycle document and silence is ambiguous, whereas here the absence of
 * the field is the absence of the concept.
 */
export function normalizeTrustEntry(entry: PackageTrustEntry): TrustedKeyEntry {
  return typeof entry === 'string' ? { publicKey: entry, status: 'active' } : entry;
}

/**
 * The trust store a validated `openmini.trust.json` describes.
 *
 * A mapping and nothing more: the validation already happened, in
 * `@openmini/shared`'s `validateTrustConfig`, and this deliberately cannot
 * be reached with anything else — its parameter is `TrustConfig`, which
 * only a successful validation produces. There is no overload taking raw
 * JSON, because a second door into the trust store is a second place for
 * the rules to differ.
 *
 * Note what has no counterpart here: there is no `emptyTrustStore()` and no
 * fallback for a configuration that failed to load. A host that reached for
 * one would register no ids, so nothing would fail closed, and an impostor
 * of a registered id would load as merely unverified — fail-open wearing
 * the word "empty". A host whose configuration is missing or invalid must
 * refuse the load path instead. See docs/plans/phase-11.md.
 */
export function trustStoreFromConfig(config: TrustConfig): PackageTrustStore {
  const store: Record<string, readonly PackageTrustEntry[]> = Object.create(null) as Record<
    string,
    readonly PackageTrustEntry[]
  >;
  for (const [id, entry] of Object.entries(config.packages)) {
    // Carried across whole, revoked keys included. Dropping them here would
    // turn a revoked key back into an unregistered one at the last moment,
    // which is the refusal W3 exists to keep distinguishable.
    store[id] = entry.keys;
  }
  return store;
}

export interface VerifyPackageInput {
  /** Normalized package root, carried into the resulting provenance. */
  baseUrl: string;
  manifestId: string;
  manifestVersion: string;
  /** The exact bytes the manifest was served as — not a re-encoding of its text. */
  manifestBytes: Uint8Array;
  /** Contents of openmini.sig.json, or undefined if the package has none. */
  signatureText: string | undefined;
  trustStore?: PackageTrustStore;
}

/**
 * Why a package was refused, as a value rather than as prose.
 *
 * `reason` stays the human sentence and is what an operator reads. This is
 * what code should branch on: the host renders an untrusted key differently
 * from an unsigned package because the remedies differ, and telling them
 * apart by matching on the message text would make the wording load-bearing.
 * `openmini verify` already separates its two failures for the same reason —
 * see docs/cli.md.
 *
 * Phase 11 W2 introduced this over the refusals that already existed, with
 * every message left byte-for-byte unchanged. W3 adds `revoked-key` — the
 * one refusal that exists *because* the code does. A revoked key and a key
 * that was never registered are a sentence apart in prose and a different
 * remedy apart in practice, and telling them apart must not require reading
 * the sentence.
 */
export type PackageRefusalCode =
  | 'unsigned-registered'
  | 'signature-invalid'
  | 'id-mismatch'
  | 'version-mismatch'
  | 'manifest-not-covered'
  | 'manifest-digest-mismatch'
  | 'untrusted-key'
  | 'revoked-key';

export type PackageVerificationOutcome =
  | {
      ok: true;
      provenance: PackageProvenance;
      /**
       * Digests every subsequent resource read must satisfy, present
       * whenever a signature validated — including one from an untrusted
       * key. Content integrity and identity are different claims, and a
       * package that is internally consistent with its own signature gets
       * the first even when it fails the second.
       */
      digests?: Readonly<Record<string, string>>;
    }
  | { ok: false; code: PackageRefusalCode; reason: string };

const MANIFEST_FILENAME = 'openmini.json';

/**
 * Applies the load-time verification policy.
 *
 * The order matters, and each step exists to close something the previous
 * one leaves open:
 *
 * 1. **A present signature is always checked, and a broken one always
 *    fails** — never degraded to "unsigned". This is the whole anti-
 *    downgrade property. If a failed signature fell back to the unsigned
 *    path, tampering with a signature file would be strictly easier than
 *    deleting it, and every check below would be optional in practice.
 *
 * 2. **The signed payload must claim the same id and version as the
 *    manifest.** Otherwise a genuine signature for one package could be
 *    served alongside another package's manifest: the signature verifies,
 *    the digests match their own payload, and the host believes an identity
 *    the signer never asserted.
 *
 * 3. **The manifest itself must be covered by the signature.** It is the
 *    file that declares permissions and network domains, so a signature
 *    that omitted it would attest to the code while leaving what the code
 *    is *allowed to do* unsigned. A payload with no `openmini.json` entry is
 *    rejected rather than treated as a package with nothing to check.
 *
 * 4. **A registered id fails closed.** If the host has said who owns an id,
 *    then a package claiming that id which is unsigned, or signed by a key
 *    the host did not register, does not load at all. Reporting it as merely
 *    "unverified" and running it anyway would make registration decorative:
 *    an attacker would strip the signature to reach the weaker path.
 *
 *    A key the host registered and later **revoked** is refused here too,
 *    and refused on its own terms rather than by being left out of the
 *    trusted set — see the comment at the decision itself. Registration is
 *    the presence of the id, so revoking every key for an id leaves it
 *    registered and still failing closed. Revocation is not a route back to
 *    step 5.
 *
 * 5. **An unregistered id may load unverified.** The host has expressed no
 *    opinion about who owns it, so there is nothing to fail closed against.
 *    It loads with `verified: false`, and the caller decides what that means
 *    — which is why the distinction is in the type rather than in a log line.
 */
export async function verifyPackage(
  input: VerifyPackageInput,
): Promise<PackageVerificationOutcome> {
  const { baseUrl, manifestId, manifestVersion, manifestBytes, signatureText, trustStore } = input;
  // Own properties only. A bare index lookup also reaches everything on
  // `Object.prototype`, so an id such as `constructor` or `__proto__` would
  // answer an inherited value and read as *registered* when the host never
  // mentioned it: an unsigned package would be refused as if its id were
  // claimed, and a signed one would reach `.map()` on a function and throw a
  // `TypeError` out of a function whose contract is to return an outcome.
  //
  // This is the dispatcher's gate, minus half of it. There the registry
  // holds callables, so `hasOwn` alone would admit an own non-function and
  // `typeof` alone would admit an inherited one, and both checks are
  // required. Here the values are key lists, so there is no callable to
  // distinguish and `hasOwn` is the whole of it.
  //
  // Not reachable through `loadMiniAppFromUrl`, whose manifest validation
  // has already required `ID_PATTERN` — a leading lowercase letter and a
  // dot. It is reachable through this function, which is exported and takes
  // any string, and `trustStoreFromConfig`'s null prototype does not cover a
  // `PackageTrustStore` a host assembles by hand as a plain literal.
  const registeredKeys =
    trustStore !== undefined && Object.hasOwn(trustStore, manifestId)
      ? trustStore[manifestId]
      : undefined;
  const isRegistered = registeredKeys !== undefined;

  if (signatureText === undefined) {
    if (isRegistered) {
      return {
        ok: false,
        code: 'unsigned-registered',
        reason: `package "${manifestId}" is registered as requiring a trusted signature, but is unsigned`,
      };
    }
    return {
      ok: true,
      provenance: { baseUrl, identity: { verified: false, reason: 'unsigned' } },
    };
  }

  // Step 1. A signature that is present and does not verify is a hard
  // failure for registered and unregistered ids alike.
  const verified = await verifySignatureFile(signatureText);
  if (!verified.ok) {
    return {
      ok: false,
      code: 'signature-invalid',
      reason: `signature verification failed: ${verified.reason}`,
    };
  }

  // Step 2.
  if (verified.payload.id !== manifestId) {
    return {
      ok: false,
      code: 'id-mismatch',
      reason: `signature is for "${verified.payload.id}" but the manifest declares "${manifestId}"`,
    };
  }
  if (verified.payload.version !== manifestVersion) {
    return {
      ok: false,
      code: 'version-mismatch',
      reason: `signature is for version "${verified.payload.version}" but the manifest declares "${manifestVersion}"`,
    };
  }

  // Step 3.
  const manifestDigest = verified.payload.files[MANIFEST_FILENAME];
  if (manifestDigest === undefined) {
    return {
      ok: false,
      code: 'manifest-not-covered',
      reason: `signature does not cover ${MANIFEST_FILENAME}, so the package's permissions are unsigned`,
    };
  }
  if (!digestsEqual(await sha256Base64(manifestBytes), manifestDigest)) {
    return {
      ok: false,
      code: 'manifest-digest-mismatch',
      reason: `${MANIFEST_FILENAME} does not match its signed digest`,
    };
  }

  // Step 4/5. Trust is decided on the complete key material, never on
  // keyId: a keyId is a label, and it costs an attacker nothing to claim
  // somebody else's.
  const signingKey = bytesToBase64(verified.publicKeySpki);
  // Matched on key material only, for revocation exactly as for trust. A
  // revocation keyed off the label would let a signer dodge their own by
  // renaming it, and let anyone revoke a publisher by copying theirs.
  const matched = (registeredKeys ?? [])
    .map(normalizeTrustEntry)
    .filter((entry) => entry.publicKey === signingKey);

  // Revocation wins over an active duplicate of the same key. The trust
  // config validator rejects that contradiction before it can be written
  // down, but `PackageTrustStore` is a plain value a host may assemble by
  // hand, and the safe reading of a contradiction is the one that withholds
  // trust: a revocation is something an operator did deliberately.
  const isRevoked = matched.some((entry) => entry.status === 'revoked');
  const trusted = matched.length > 0 && !isRevoked;

  // Refused on its own terms, and deliberately not by dropping revoked
  // entries from the trusted set and letting the branch below report it.
  // That shortcut is the downgrade this phase exists to prevent:
  // `untrusted-key` refuses a registered id today, but it is also the label
  // an *unregistered* id carries while loading unverified into the shared
  // origin storage tier. Routing a revoked key through it would leave the
  // two one policy edit apart, and the operator with no way to tell a
  // compromised key from an unknown one.
  if (isRevoked) {
    return {
      ok: false,
      code: 'revoked-key',
      reason: `package "${manifestId}" is signed by a key the host has revoked for it (keyId ${verified.keyId})`,
    };
  }

  if (isRegistered && !trusted) {
    return {
      ok: false,
      code: 'untrusted-key',
      reason: `package "${manifestId}" is registered, but is signed by a key the host does not trust (keyId ${verified.keyId})`,
    };
  }

  return {
    ok: true,
    digests: verified.payload.files,
    provenance: {
      baseUrl,
      identity: trusted
        ? { verified: true, id: manifestId, keyId: verified.keyId }
        : { verified: false, reason: 'untrusted-key' },
    },
  };
}
