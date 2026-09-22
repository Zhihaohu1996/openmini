import { bytesToBase64, digestsEqual, sha256Base64, verifySignatureFile } from '@openmini/shared';
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
 * material is the anchor. See @openmini/shared's integrity module.
 *
 * An id present here is *registered*: the host is asserting it knows who
 * owns that id. That assertion is what makes fail-closed possible, and it is
 * the only thing that does.
 */
export type PackageTrustStore = Readonly<Record<string, readonly string[]>>;

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
  | { ok: false; reason: string };

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
 * 5. **An unregistered id may load unverified.** The host has expressed no
 *    opinion about who owns it, so there is nothing to fail closed against.
 *    It loads with `verified: false`, and the caller decides what that means
 *    — which is why the distinction is in the type rather than in a log line.
 */
export async function verifyPackage(
  input: VerifyPackageInput,
): Promise<PackageVerificationOutcome> {
  const { baseUrl, manifestId, manifestVersion, manifestBytes, signatureText, trustStore } = input;
  const registeredKeys = trustStore?.[manifestId];
  const isRegistered = registeredKeys !== undefined;

  if (signatureText === undefined) {
    if (isRegistered) {
      return {
        ok: false,
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
    return { ok: false, reason: `signature verification failed: ${verified.reason}` };
  }

  // Step 2.
  if (verified.payload.id !== manifestId) {
    return {
      ok: false,
      reason: `signature is for "${verified.payload.id}" but the manifest declares "${manifestId}"`,
    };
  }
  if (verified.payload.version !== manifestVersion) {
    return {
      ok: false,
      reason: `signature is for version "${verified.payload.version}" but the manifest declares "${manifestVersion}"`,
    };
  }

  // Step 3.
  const manifestDigest = verified.payload.files[MANIFEST_FILENAME];
  if (manifestDigest === undefined) {
    return {
      ok: false,
      reason: `signature does not cover ${MANIFEST_FILENAME}, so the package's permissions are unsigned`,
    };
  }
  if (!digestsEqual(await sha256Base64(manifestBytes), manifestDigest)) {
    return { ok: false, reason: `${MANIFEST_FILENAME} does not match its signed digest` };
  }

  // Step 4/5. Trust is decided on the complete key material, never on
  // keyId: a keyId is a label, and it costs an attacker nothing to claim
  // somebody else's.
  const signingKey = bytesToBase64(verified.publicKeySpki);
  const trusted = registeredKeys?.some((key) => key === signingKey) ?? false;

  if (isRegistered && !trusted) {
    return {
      ok: false,
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
