import { bytesToBase64, generateSigningKeyPair, INTEGRITY_ALGORITHM } from '@openmini/shared';
import { rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Generates the P-256 signing key `openmini sign` uses.
 *
 * The key file holds the private key **unencrypted**. That is a real
 * limitation and is stated in the command's output rather than buried here:
 * a passphrase-wrapped key needs a KDF, a prompt, and a decision about
 * non-interactive CI use, none of which this phase makes. Until then the
 * file's protection is the filesystem's, so it is written 0600 and the
 * caller is told to keep it out of the package and out of version control.
 */

export class KeygenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeygenError';
  }
}

export interface KeygenOptions {
  /** Destination key file path. */
  out: string;
  /** Overwrite an existing file. Without it, an existing path is an error. */
  force?: boolean;
}

export interface KeygenResult {
  keyFile: string;
  keyId: string;
  publicKey: string;
}

export const KEY_FILE_VERSION = 1;

export interface KeyFile {
  keyVersion: number;
  algorithm: typeof INTEGRITY_ALGORITHM;
  keyId: string;
  /** base64 PKCS#8. Secret. */
  privateKey: string;
  /** base64 SPKI. Safe to publish — this is what a host puts in its trust store. */
  publicKey: string;
}

export async function generateKeyFile(options: KeygenOptions): Promise<KeygenResult> {
  const keyFile = resolve(options.out);

  const pair = await generateSigningKeyPair();
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey));

  const contents: KeyFile = {
    keyVersion: KEY_FILE_VERSION,
    algorithm: INTEGRITY_ALGORITHM,
    keyId: pair.keyId,
    privateKey: bytesToBase64(pkcs8),
    publicKey: bytesToBase64(pair.publicKeySpki),
  };

  const serialized = `${JSON.stringify(contents, null, 2)}\n`;

  if (options.force) {
    await replaceKeyFile(keyFile, serialized);
    return { keyFile, keyId: pair.keyId, publicKey: contents.publicKey };
  }

  try {
    await writeFile(keyFile, serialized, {
      encoding: 'utf8',
      // `wx` fails if the path exists, so refusing to overwrite is enforced
      // by the open itself rather than by a check-then-write that another
      // process could slip between. Mode 0600 is applied at creation, not
      // afterwards, so the key is never briefly world-readable.
      flag: 'wx',
      mode: 0o600,
    });
  } catch (error) {
    // Structurally typed rather than named as `NodeJS.ErrnoException`: that
    // is a type-only global, so naming it trips the lint config's `no-undef`,
    // which only knows about runtime globals. Same workaround, and same
    // reason, as `BoundedFetchInit` in the runtime's boundedFetch.
    if ((error as { code?: string }).code === 'EEXIST') {
      throw new KeygenError(
        `${keyFile} already exists. Use --force to overwrite it — but note that the old key is then unrecoverable, and packages signed with it can no longer be re-signed.`,
      );
    }
    throw error;
  }

  return { keyFile, keyId: pair.keyId, publicKey: contents.publicKey };
}

/**
 * `--force`: writes the new key beside the old one, then renames it into place.
 *
 * Opening the target itself with `w` would give up both of the exclusive
 * create's protections. `mode` applies only when a file is created, so an
 * existing 0644 file would stay 0644 with the new private key in it; and `w`
 * follows a symlink at the path, writing the key wherever the link points.
 * It also truncates first, so a write that fails part-way loses the old key
 * with no new one to replace it.
 *
 * A fresh exclusive create gets the mode right from the start, and `rename`
 * replaces whatever is at the path — a symlink included — rather than writing
 * through it, so the old key stays intact until the new one is complete. The
 * temp file sits in the target's own directory, so the rename never crosses a
 * filesystem. A process killed between the write and the rename leaves the
 * temp file behind; it is 0600 like any key file, and its random name means
 * it never collides with the next attempt.
 */
async function replaceKeyFile(keyFile: string, serialized: string): Promise<void> {
  const temp = `${keyFile}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temp, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    await rename(temp, keyFile);
  } catch (error) {
    // Best effort, so the error reported is the one that caused the failure.
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}
