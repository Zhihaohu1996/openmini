import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import {
  base64ToBytes,
  importSigningKey,
  INTEGRITY_ALGORITHM,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  signIntegrityPayload,
  SIGNATURE_FILENAME,
} from '@openmini/shared';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { digestPackageFiles, PackageFilesError } from '../packageFiles.js';
import { KEY_FILE_VERSION } from './keygen.js';

/**
 * Signs a built package, writing a detached `openmini.sig.json`.
 *
 * Signing is a separate step from `build` on purpose. `build` is required to
 * be byte-reproducible — identical inputs and tool version produce identical
 * output — and ECDSA signatures are randomized, so a build that signed its
 * own output could never be reproducible. Keeping them apart means a package
 * can be rebuilt and compared byte for byte by anyone, and the signature is
 * an assertion layered on top of that reproducible artifact rather than a
 * thing that destroys it.
 */

export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignError';
  }
}

export interface SignOptions {
  /** Built package directory — the one containing openmini.json. */
  packageDir: string;
  /** Key file produced by `openmini keygen`. */
  keyFile: string;
}

export interface SignResult {
  signatureFile: string;
  keyId: string;
  fileCount: number;
  id: string;
  version: string;
}

const MANIFEST_FILENAME = 'openmini.json';

async function readKeyFile(
  path: string,
): Promise<{ privateKeyPkcs8: Uint8Array; spki: Uint8Array }> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    throw new SignError(
      `cannot read key file: ${path}\nRun "openmini keygen --out ${path}" first.`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SignError(`key file is not valid JSON: ${path}`);
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new SignError(`key file is not an object: ${path}`);
  }
  const key = parsed as Record<string, unknown>;
  if (key.keyVersion !== KEY_FILE_VERSION) {
    throw new SignError(
      `unsupported key file version in ${path} (expected ${KEY_FILE_VERSION}, got ${JSON.stringify(key.keyVersion)})`,
    );
  }
  if (key.algorithm !== INTEGRITY_ALGORITHM) {
    throw new SignError(`key file algorithm must be "${INTEGRITY_ALGORITHM}": ${path}`);
  }
  if (typeof key.privateKey !== 'string' || typeof key.publicKey !== 'string') {
    throw new SignError(`key file is missing privateKey/publicKey: ${path}`);
  }

  try {
    return { privateKeyPkcs8: base64ToBytes(key.privateKey), spki: base64ToBytes(key.publicKey) };
  } catch {
    throw new SignError(`key file contains malformed base64: ${path}`);
  }
}

/**
 * Refuses a key file that lives inside the package being signed.
 *
 * The package walk covers every file under `packageDir`, so a key kept there
 * would be signed into the package and shipped with it, and `verify` would
 * then report it as covered — the private key published by the very step
 * meant to attest the package. Checked before anything is digested.
 *
 * Both paths exist by now (the key file has just been read), so both go
 * through `realpath`: a symlinked spelling of the package, or of a folder in
 * it, is still recognised. The containment test is the one `build` uses for
 * `--out`, on whole path segments: `..`, a path under `..`, or an absolute
 * path (another Windows drive) is outside, and anything else is inside. A
 * string-prefix comparison would also refuse a sibling such as `pkg-keys/`
 * next to `pkg/`. `relative` compares case-insensitively on Windows.
 */
async function refuseKeyInsidePackage(packageDir: string, keyFile: string): Promise<void> {
  const [realPackageDir, realKeyFile] = await Promise.all([
    realpath(packageDir),
    realpath(keyFile),
  ]);
  const rel = relative(realPackageDir, realKeyFile);
  const outside = rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel);
  if (!outside) {
    throw new SignError(
      `key file is inside the package directory: ${keyFile}\nSigning would cover it and ship the private key with the package. Keep the key outside ${packageDir}.`,
    );
  }
}

export async function signPackage(options: SignOptions): Promise<SignResult> {
  const packageDir = resolve(options.packageDir);

  // The manifest is read and validated first: the signature binds `id` and
  // `version`, so signing a package whose manifest is invalid would produce
  // an attestation about an identity the runtime will refuse to load anyway.
  let manifestRaw: string;
  try {
    manifestRaw = await readFile(join(packageDir, MANIFEST_FILENAME), 'utf8');
  } catch {
    throw new SignError(
      `cannot read ${MANIFEST_FILENAME} in ${packageDir}\nSign a built package directory, not an authoring project.`,
    );
  }
  const manifestResult = parseManifest(manifestRaw);
  if (!manifestResult.valid) {
    throw new SignError(formatManifestIssues(manifestResult.issues));
  }
  const manifest = manifestResult.manifest;

  const keyFile = resolve(options.keyFile);
  const { privateKeyPkcs8, spki } = await readKeyFile(keyFile);
  await refuseKeyInsidePackage(packageDir, keyFile);

  let files;
  try {
    // Walks, rejects symlinks, and excludes openmini.sig.json — so re-signing
    // a package never digests a previous signature.
    files = await digestPackageFiles(packageDir);
  } catch (error) {
    if (error instanceof PackageFilesError) {
      throw new SignError(error.message);
    }
    throw error;
  }

  let privateKey;
  try {
    privateKey = await importSigningKey(privateKeyPkcs8);
  } catch {
    throw new SignError(`key file does not contain a valid P-256 private key: ${options.keyFile}`);
  }

  const envelope = await signIntegrityPayload(
    {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id: manifest.id,
      version: manifest.version,
      files,
    },
    privateKey,
    spki,
  );

  const signatureFile = join(packageDir, SIGNATURE_FILENAME);
  await writeFile(signatureFile, serializeSignatureEnvelope(envelope), 'utf8');

  return {
    signatureFile,
    keyId: envelope.keyId,
    fileCount: Object.keys(files).length,
    id: manifest.id,
    version: manifest.version,
  };
}
