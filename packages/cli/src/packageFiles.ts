import { sha256Base64, SIGNATURE_FILENAME } from '@openmini/shared';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/**
 * Enumerates and digests the files of a built package.
 *
 * Shared by `sign` and `verify` deliberately: the set of files a signature
 * covers and the set a verifier checks must be produced by one piece of
 * code. Two walks that disagree about what belongs in a package — about a
 * dotfile, a nested directory, a path separator — is a signature that passes
 * on the machine that made it and fails everywhere else.
 */

export class PackageFilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageFilesError';
  }
}

/**
 * Package-relative POSIX path -> `sha256-<base64>` of that file's bytes.
 *
 * POSIX-shaped on every platform: `path.sep` is `\` on Windows, and a
 * signature listing `src\index.html` would be unverifiable by a browser
 * runtime that only ever sees `/`. The separator is normalized here, at the
 * one place paths enter the format.
 */
export type PackageFileDigests = Record<string, string>;

/**
 * Recursively lists a package's files as sorted, package-root-relative POSIX
 * paths.
 *
 * Sorted so the walk is deterministic: `readdir` order is filesystem-defined
 * and differs between machines, and while the payload is opaque to the
 * signature (so ordering cannot break verification), a signer that emitted a
 * different byte string for an unchanged package on every run would make
 * signed artifacts needlessly unstable and their diffs unreadable.
 *
 * `openmini.sig.json` is excluded. It cannot attest to itself: its bytes
 * contain the signature, so its digest is not computable before it exists.
 * Excluded at the walk rather than filtered later, so neither the signer nor
 * the verifier can reintroduce it by accident.
 */
export async function listPackageFiles(packageDir: string): Promise<string[]> {
  const found: string[] = [];

  async function walk(absDir: string): Promise<void> {
    const entries = await readdir(absDir, { withFileTypes: true });
    // Sorted per directory, and the full list sorted again below, so the
    // result does not depend on readdir order at any level.
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const abs = join(absDir, entry.name);

      // `withFileTypes` reports symlinks without following them, which is
      // what makes this check possible at all.
      //
      // Rejected rather than followed or skipped. Following one means
      // digesting bytes from outside the package — the signature would then
      // vouch for content the package does not contain and cannot ship, and
      // which can change after signing. Skipping one silently drops a file
      // the author put there. Neither is a thing to do quietly, and this
      // matches the deliberate no-symlink-resolution stance already recorded
      // in the runtime's containment module and in `build`'s --out check.
      if (entry.isSymbolicLink()) {
        throw new PackageFilesError(
          `refusing to sign a package containing a symlink: ${toPosix(relative(packageDir, abs))}\n` +
            'A signature must cover bytes the package actually ships. Replace the link with a real file.',
        );
      }

      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) {
        // Sockets, FIFOs and devices have no stable bytes to digest.
        throw new PackageFilesError(
          `refusing to sign a package containing a non-regular file: ${toPosix(relative(packageDir, abs))}`,
        );
      }

      const rel = toPosix(relative(packageDir, abs));
      if (rel === SIGNATURE_FILENAME) {
        continue;
      }
      found.push(rel);
    }
  }

  await walk(packageDir);
  return found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

/** Digests every file the walk returns, reading bytes and never text. */
export async function digestPackageFiles(packageDir: string): Promise<PackageFileDigests> {
  const paths = await listPackageFiles(packageDir);
  if (paths.length === 0) {
    throw new PackageFilesError(`no files to sign in ${packageDir}`);
  }

  const digests: PackageFileDigests = {};
  for (const rel of paths) {
    // Read as bytes, never as text. A digest over a decoded string would be
    // a digest of something the file does not contain: invalid UTF-8 decodes
    // to U+FFFD, so two different files can share one string form.
    const bytes = await readFile(join(packageDir, ...rel.split('/')));
    digests[rel] = await sha256Base64(bytes);
  }
  return digests;
}
