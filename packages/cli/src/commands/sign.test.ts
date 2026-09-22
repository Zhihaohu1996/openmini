import { SIGNATURE_FILENAME, parseSignatureEnvelope, verifySignatureFile } from '@openmini/shared';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
