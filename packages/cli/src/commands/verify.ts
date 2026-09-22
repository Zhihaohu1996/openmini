import { digestsEqual, SIGNATURE_FILENAME, verifySignatureFile } from '@openmini/shared';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { digestPackageFiles, PackageFilesError } from '../packageFiles.js';

/**
 * Checks a package against its detached signature.
 *
 * Two questions, answered in order and reported separately, because they
 * fail for different reasons and a user needs to know which happened:
 *
 * 1. Is the signature valid for the payload it carries? (cryptographic)
 * 2. Do the files on disk match the digests that payload lists? (content)
 *
 * A failure of (1) means the signature file was altered or was never
 * genuine. A failure of (2) means the signature is authentic but the package
 * has been modified since it was signed. Collapsing them into one "invalid"
 * would hide which.
 *
 * Note what this command does *not* do: decide whether the signing key
 * should be trusted. It reports the key, and trust is the host's policy —
 * see the runtime's trust store. A package signed by an attacker's own key
 * verifies here exactly as a legitimate one does, which is why the keyId and
 * public key are always printed.
 */

export interface VerifyPackageResult {
  ok: boolean;
  /** Human-readable report, already formatted for printing. */
  report: string;
  /** Present when the signature itself verified, whatever the file check found. */
  keyId?: string;
  publicKey?: string;
}

export async function verifyPackage(target: string): Promise<VerifyPackageResult> {
  const packageDir = resolve(target);
  const signaturePath = join(packageDir, SIGNATURE_FILENAME);

  let raw: string;
  try {
    raw = await readFile(signaturePath, 'utf8');
  } catch {
    // Unsigned is not "invalid" — it is a package that makes no claim. The
    // message says which, because the remedy is different.
    return {
      ok: false,
      report: `${packageDir}: unsigned (no ${SIGNATURE_FILENAME})\nRun "openmini sign <dir> --key <keyfile>" to sign it.`,
    };
  }

  const verified = await verifySignatureFile(raw);
  if (!verified.ok) {
    return { ok: false, report: `${signaturePath}: ${verified.reason}` };
  }

  const { payload, keyId } = verified;
  const publicKey = Buffer.from(verified.publicKeySpki).toString('base64');

  let onDisk;
  try {
    onDisk = await digestPackageFiles(packageDir);
  } catch (error) {
    if (error instanceof PackageFilesError) {
      return { ok: false, report: `${packageDir}: ${error.message}` };
    }
    throw error;
  }

  const problems: string[] = [];

  for (const [path, expected] of Object.entries(payload.files)) {
    const actual = onDisk[path];
    if (actual === undefined) {
      problems.push(`  missing: ${path} (listed in the signature but not in the package)`);
      continue;
    }
    if (!digestsEqual(actual, expected)) {
      problems.push(`  modified: ${path}`);
    }
  }

  // A file present on disk but absent from the payload is unattested
  // content, and reported as a failure rather than ignored. A signature that
  // covers only some of a package's files is a signature an attacker can
  // satisfy by adding files rather than changing them.
  for (const path of Object.keys(onDisk)) {
    if (!(path in payload.files)) {
      problems.push(
        `  unsigned: ${path} (present in the package but not covered by the signature)`,
      );
    }
  }

  if (problems.length > 0) {
    return {
      ok: false,
      keyId,
      publicKey,
      report: [
        `${packageDir}: signature is authentic, but the package does not match it`,
        ...problems.sort(),
        `  signed by keyId ${keyId}`,
      ].join('\n'),
    };
  }

  return {
    ok: true,
    keyId,
    publicKey,
    report: [
      `${packageDir}: verified (${payload.id} ${payload.version}, ${Object.keys(payload.files).length} files)`,
      `  keyId     ${keyId}`,
      `  publicKey ${publicKey}`,
      '',
      'This confirms the package matches its signature. It does NOT say the',
      'signing key is trusted — compare the public key above against your',
      "host's trust store.",
    ].join('\n'),
  };
}
