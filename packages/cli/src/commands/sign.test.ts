import { SIGNATURE_FILENAME, parseSignatureEnvelope, verifySignatureFile } from '@openmini/shared';
import { createHash } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { generateKeyFile } from './keygen';
import { signPackage } from './sign';
import { verifyPackage } from './verify';

const MANIFEST = `{
  "schemaVersion": 1,
  "id": "com.example.signed",
  "name": "Signed",
  "version": "1.2.3",
  "entry": "index.html",
  "permissions": []
}
`;

async function makePackage(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-sign-'));
  await writeFile(join(dir, 'openmini.json'), MANIFEST, 'utf8');
  await writeFile(join(dir, 'index.html'), '<!doctype html><title>x</title>', 'utf8');
  return dir;
}

async function makeKey(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
  const keyFile = join(dir, 'signing.key.json');
  await generateKeyFile({ out: keyFile });
  return keyFile;
}

describe('signPackage', () => {
  it('writes a detached signature that verifies against the package', async () => {
    const dir = await makePackage();
    const keyFile = await makeKey();

    const result = await signPackage({ packageDir: dir, keyFile });
    expect(result.id).toBe('com.example.signed');
    expect(result.version).toBe('1.2.3');
    expect(result.fileCount).toBe(2);

    await expect(verifyPackage(dir)).resolves.toMatchObject({ ok: true });
  });

  it('never lists the signature file among the files it signs', async () => {
    // It cannot attest to itself: its bytes contain the signature, so its
    // digest is not computable before it exists.
    const dir = await makePackage();
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });

    const verified = await verifySignatureFile(
      await readFile(join(dir, SIGNATURE_FILENAME), 'utf8'),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Object.keys(verified.payload.files).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it('re-signs a signed package without digesting the previous signature', async () => {
    const dir = await makePackage();
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });
    const second = await signPackage({ packageDir: dir, keyFile });

    expect(second.fileCount).toBe(2);
    await expect(verifyPackage(dir)).resolves.toMatchObject({ ok: true });
  });

  it('uses package-root-relative POSIX paths for nested files', async () => {
    // A signature listing `assets\app.css` would be unverifiable by a
    // browser runtime that only ever sees forward slashes.
    const dir = await makePackage();
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'app.css'), 'body{}', 'utf8');
    const keyFile = await makeKey();

    await signPackage({ packageDir: dir, keyFile });
    const verified = await verifySignatureFile(
      await readFile(join(dir, SIGNATURE_FILENAME), 'utf8'),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    expect(Object.keys(verified.payload.files)).toContain('assets/app.css');
  });

  it('emits file paths in a deterministic order', async () => {
    const dir = await makePackage();
    await mkdir(join(dir, 'assets'), { recursive: true });
    await writeFile(join(dir, 'assets', 'z.css'), 'z', 'utf8');
    await writeFile(join(dir, 'assets', 'a.css'), 'a', 'utf8');
    const keyFile = await makeKey();

    await signPackage({ packageDir: dir, keyFile });
    const envelope = parseSignatureEnvelope(await readFile(join(dir, SIGNATURE_FILENAME), 'utf8'));
    expect(envelope.ok).toBe(true);
    if (!envelope.ok) return;
    // readdir order is filesystem-defined; the payload must not be.
    const paths = Object.keys(JSON.parse(envelope.envelope.payload).files);
    expect(paths).toEqual([...paths].sort());
  });

  it('refuses to sign a package containing a symlink', async () => {
    // A signature must cover bytes the package ships. A link's target may
    // sit outside the package and may change after signing.
    const dir = await makePackage();
    const keyFile = await makeKey();
    try {
      await symlink(join(dir, 'index.html'), join(dir, 'link.html'));
    } catch {
      // Unprivileged Windows cannot create symlinks; the rule is still
      // enforced, just not observable here.
      return;
    }

    await expect(signPackage({ packageDir: dir, keyFile })).rejects.toThrow(/symlink/);
  });

  it('refuses to sign a package whose manifest is invalid', async () => {
    // The signature binds id and version, so an unparseable manifest would
    // produce an attestation about an identity the runtime rejects anyway.
    const dir = await makePackage();
    await writeFile(join(dir, 'openmini.json'), '{ broken', 'utf8');
    const keyFile = await makeKey();
    await expect(signPackage({ packageDir: dir, keyFile })).rejects.toThrow(/manifest/i);
  });

  it('reports a missing manifest as signing the wrong directory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-empty-'));
    const keyFile = await makeKey();
    await expect(signPackage({ packageDir: dir, keyFile })).rejects.toThrow(/openmini\.json/);
  });

  it('reports a missing key file', async () => {
    const dir = await makePackage();
    await expect(signPackage({ packageDir: dir, keyFile: join(dir, 'nope.json') })).rejects.toThrow(
      /cannot read key file/,
    );
  });

  it('rejects a key file of an unsupported version', async () => {
    const dir = await makePackage();
    const keyFile = await makeKey();
    const key = JSON.parse(await readFile(keyFile, 'utf8'));
    await writeFile(keyFile, JSON.stringify({ ...key, keyVersion: 99 }), 'utf8');
    await expect(signPackage({ packageDir: dir, keyFile })).rejects.toThrow(
      /unsupported key file version/,
    );
  });

  it('covers a package-root file named __proto__ instead of silently leaving it out', async () => {
    // Phase 14 W1. On a plain-object digest map this assignment reached the
    // inherited `__proto__` setter and the entry was never created: the
    // signer reported 2 files with 3 on disk, and the payload did not cover
    // the third. `__proto__` is a legal file name, so it must be covered.
    const dir = await makePackage();
    const bytes = Buffer.from('a file honestly named __proto__', 'utf8');
    await writeFile(join(dir, '__proto__'), bytes);
    const keyFile = await makeKey();

    const result = await signPackage({ packageDir: dir, keyFile });
    expect(result.fileCount).toBe(3);

    const verified = await verifySignatureFile(
      await readFile(join(dir, SIGNATURE_FILENAME), 'utf8'),
    );
    expect(verified.ok).toBe(true);
    if (!verified.ok) return;
    // Own property, asserted with `hasOwn`: an index or `toHaveProperty`
    // would be satisfied by the inherited member and prove nothing.
    expect(Object.hasOwn(verified.payload.files, '__proto__')).toBe(true);
    expect(verified.payload.files['__proto__']).toBe(
      `sha256-${createHash('sha256').update(bytes).digest('base64')}`,
    );
  });
});

describe('verifyPackage', () => {
  it('reports an unsigned package as unsigned, not as invalid', async () => {
    // Different remedy, so a different message: nothing is wrong with the
    // package, it simply makes no claim.
    const dir = await makePackage();
    const result = await verifyPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/unsigned/);
  });

  it('detects a file modified after signing', async () => {
    const dir = await makePackage();
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });
    await writeFile(join(dir, 'index.html'), '<!doctype html><title>evil</title>', 'utf8');

    const result = await verifyPackage(dir);
    expect(result.ok).toBe(false);
    // The signature is still authentic; the package no longer matches it.
    expect(result.report).toMatch(/signature is authentic/);
    expect(result.report).toMatch(/modified: index\.html/);
  });

  it('detects a file added after signing', async () => {
    // A signature covering only some files is one an attacker satisfies by
    // adding content rather than changing it.
    const dir = await makePackage();
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });
    await writeFile(join(dir, 'extra.js'), 'alert(1)', 'utf8');

    const result = await verifyPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/unsigned: extra\.js/);
  });

  it('detects a file deleted after signing', async () => {
    const dir = await makePackage();
    await writeFile(join(dir, 'gone.txt'), 'here', 'utf8');
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });
    await rm(join(dir, 'gone.txt'));

    const result = await verifyPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/missing: gone\.txt/);
  });

  it('rejects a tampered signature file', async () => {
    const dir = await makePackage();
    const keyFile = await makeKey();
    await signPackage({ packageDir: dir, keyFile });

    const raw = JSON.parse(await readFile(join(dir, SIGNATURE_FILENAME), 'utf8'));
    raw.payload = raw.payload.replace('1.2.3', '9.9.9');
    await writeFile(join(dir, SIGNATURE_FILENAME), JSON.stringify(raw), 'utf8');

    const result = await verifyPackage(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/signature does not match the payload/);
  });

  it('verifies a package signed by an untrusted key, and says trust is separate', async () => {
    // The residual limitation, made explicit: anyone can sign with their own
    // key. Only a trust store can reject that, and this command has none.
    const dir = await makePackage();
    const attackerKey = await makeKey();
    await signPackage({ packageDir: dir, keyFile: attackerKey });

    const result = await verifyPackage(dir);
    expect(result.ok).toBe(true);
    expect(result.report).toMatch(/does NOT say the/);
    expect(result.publicKey).toBeTruthy();
  });

  // Phase 14 W1. `verify` digests the disk through the same function `sign`
  // does, so the plain-object map hid files from it too. Each case below
  // has an ordinary-name twin above; these are the prototype names.
  describe('prototype-named files', () => {
    it('verifies an honest package containing a file named __proto__', async () => {
      // The positive control: covering the file must not make it refused.
      const dir = await makePackage();
      await writeFile(join(dir, '__proto__'), 'honest', 'utf8');
      const keyFile = await makeKey();
      await signPackage({ packageDir: dir, keyFile });

      const result = await verifyPackage(dir);
      expect(result.ok).toBe(true);
      expect(result.report).toMatch(/verified \(com\.example\.signed 1\.2\.3, 3 files\)/);
    });

    it('detects a file named __proto__ added after signing', async () => {
      // Previously reported as verified: the file never entered the on-disk
      // map, so the "present but not covered" walk never saw it.
      const dir = await makePackage();
      const keyFile = await makeKey();
      await signPackage({ packageDir: dir, keyFile });
      await writeFile(join(dir, '__proto__'), 'alert(1)', 'utf8');

      const result = await verifyPackage(dir);
      expect(result.ok).toBe(false);
      expect(result.report).toMatch(/unsigned: __proto__ \(present in the package/);
    });

    it('reports a signed file named constructor, deleted after signing, as missing', async () => {
      // Previously `modified`: the absent name answered the inherited
      // `Object` function instead of undefined. Still a failure either way;
      // this is about telling the operator the true reason.
      const dir = await makePackage();
      await writeFile(join(dir, 'constructor'), 'here', 'utf8');
      const keyFile = await makeKey();
      await signPackage({ packageDir: dir, keyFile });
      await rm(join(dir, 'constructor'));

      const result = await verifyPackage(dir);
      expect(result.ok).toBe(false);
      expect(result.report).toMatch(/missing: constructor \(listed in the signature/);
      expect(result.report).not.toMatch(/modified: constructor/);
    });
  });
});

describe('generateKeyFile', () => {
  it('refuses to overwrite an existing key file without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    await generateKeyFile({ out });
    await expect(generateKeyFile({ out })).rejects.toThrow(/already exists/);
  });

  it('overwrites with force, producing a different key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    const first = await generateKeyFile({ out });
    const second = await generateKeyFile({ out, force: true });
    expect(second.keyId).not.toBe(first.keyId);
  });

  it('derives keyId from the public key, so it is reproducible from the key alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    const result = await generateKeyFile({ out });
    const onDisk = JSON.parse(await readFile(out, 'utf8'));
    expect(onDisk.keyId).toBe(result.keyId);
    expect(onDisk.publicKey).toBe(result.publicKey);
  });

  // File modes and symlinks are POSIX behaviour: on Windows Node ignores the
  // mode and creating a symlink needs a privilege, so these two run in Linux
  // CI and not locally. The failed-write case below needs neither and runs
  // everywhere.
  const posixOnly = process.platform !== 'win32';

  it.runIf(posixOnly)('writes 0600 with --force, even over an existing 0644 file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    await writeFile(out, 'old\n', 'utf8');
    await chmod(out, 0o644);

    await generateKeyFile({ out, force: true });

    expect((await stat(out)).mode & 0o777).toBe(0o600);
  });

  it.runIf(posixOnly)(
    'replaces a symlink at the path with --force instead of writing through it',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
      const elsewhere = join(dir, 'elsewhere.txt');
      await writeFile(elsewhere, 'not a key\n', 'utf8');
      const out = join(dir, 'k.json');
      await symlink(elsewhere, out);

      const result = await generateKeyFile({ out, force: true });

      expect(await readFile(elsewhere, 'utf8')).toBe('not a key\n');
      expect((await lstat(out)).isSymbolicLink()).toBe(false);
      expect(JSON.parse(await readFile(out, 'utf8')).keyId).toBe(result.keyId);
    },
  );

  it('keeps the old key intact when a --force write fails, and leaves no temp file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    await generateKeyFile({ out });
    const before = await readFile(out);

    // The open succeeds and the write does not — what a full disk does. The
    // fake creates the file it was asked to (with the caller's flag, so a
    // `w` open truncates) and then fails, so the test observes whatever the
    // file it opened is left holding.
    vi.resetModules();
    vi.doMock('node:fs/promises', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs/promises')>();
      return {
        ...actual,
        writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
          await actual.writeFile(args[0], '', args[2]);
          throw Object.assign(new Error('simulated write failure'), { code: 'EIO' });
        },
      };
    });
    try {
      const { generateKeyFile: generateWithFailingWrite } = await import('./keygen');
      await expect(generateWithFailingWrite({ out, force: true })).rejects.toThrow(
        /simulated write failure/,
      );
    } finally {
      vi.doUnmock('node:fs/promises');
      vi.resetModules();
    }

    expect(await readFile(out)).toEqual(before);
    expect(await readdir(dir)).toEqual(['k.json']);
  });

  it('writes a key that signs and verifies after --force replaces an existing one', async () => {
    const pkg = await makePackage();
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const keyFile = join(dir, 'k.json');
    await generateKeyFile({ out: keyFile });
    const replaced = await generateKeyFile({ out: keyFile, force: true });

    const signed = await signPackage({ packageDir: pkg, keyFile });
    expect(signed.keyId).toBe(replaced.keyId);
    expect((await verifyPackage(pkg)).ok).toBe(true);
  });

  // --force replaces the key through a temp file, but its failures keep the
  // messages the old in-place open gave, wherever that open did not depend
  // on the in-place write itself. Phase 15's plan lists the classes that may
  // differ (D1-D6); none of the cases below is one of them.
  const messageOf = (promise: Promise<unknown>): Promise<string | null> =>
    promise.then(
      () => null,
      (error: Error) => error.message,
    );

  it('fails --force into a missing folder exactly as it fails without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'missing', 'k.json');

    const plain = await messageOf(generateKeyFile({ out }));
    const forced = await messageOf(generateKeyFile({ out, force: true }));

    expect(plain).toMatch(/^ENOENT: /);
    expect(forced).toBe(plain);
    expect(await readdir(dir)).toEqual([]);
  });

  it('fails --force under a parent that is a file exactly as it fails without --force', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    await writeFile(join(dir, 'parent'), 'not a folder\n', 'utf8');
    const out = join(dir, 'parent', 'k.json');

    const plain = await messageOf(generateKeyFile({ out }));
    const forced = await messageOf(generateKeyFile({ out, force: true }));

    expect(plain).not.toBeNull();
    expect(forced).toBe(plain);
    expect(await readdir(dir)).toEqual(['parent']);
  });

  it('fails --force onto a directory with the EISDIR the old in-place open gave', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
    const out = join(dir, 'k.json');
    await mkdir(out);

    await expect(generateKeyFile({ out, force: true })).rejects.toMatchObject({
      code: 'EISDIR',
      syscall: 'open',
      path: out,
      message: `EISDIR: illegal operation on a directory, open '${out}'`,
    });
    expect(await readdir(out)).toEqual([]);
    expect(await readdir(dir)).toEqual(['k.json']);
  });

  // Root can write a read-only file, so the old open succeeded there too.
  it.runIf(process.getuid?.() !== 0)(
    'fails --force onto a read-only key file as the old in-place open did, keeping the key',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'openmini-key-'));
      const out = join(dir, 'k.json');
      await generateKeyFile({ out });
      await chmod(out, 0o444);
      const before = await readFile(out);

      // The old --force write opened the target with `w`. On a read-only
      // file that open fails before it can truncate anything, so trying it
      // here is safe, and gives the exact error to match.
      const legacy = await open(out, 'w').then(
        async (handle) => {
          await handle.close();
          return null;
        },
        (error: Error & { code?: string }) => error,
      );
      expect(legacy).not.toBeNull();

      await expect(generateKeyFile({ out, force: true })).rejects.toMatchObject({
        code: legacy?.code,
        syscall: 'open',
        path: out,
        message: legacy?.message,
      });
      expect(await readFile(out)).toEqual(before);
      expect(await readdir(dir)).toEqual(['k.json']);
      await chmod(out, 0o644);
    },
  );
});
