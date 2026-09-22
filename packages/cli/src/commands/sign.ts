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
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
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

  const { privateKeyPkcs8, spki } = await readKeyFile(resolve(options.keyFile));

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
