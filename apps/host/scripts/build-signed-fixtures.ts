#!/usr/bin/env node
/**
 * Generates the signed packages the verification e2e loads, and the trust
 * config the host is configured with.
 *
 * The signing key is **ephemeral**: a fresh P-256 pair per fixture build,
 * used immediately and never written to disk. That is the point. A key
 * committed to the repository would be a published private key that signs
 * packages a real host is configured to trust, and the fact that it is "only
 * for tests" survives exactly as long as nobody copies the pattern. Nothing
 * here needs a stable key — every consumer of these fixtures is regenerated
 * in the same run.
 *
 * Four packages, covering the four outcomes the load path distinguishes:
 *
 *   signed-trusted    registered id, signed by the registered key -> verified
 *   signed-untrusted  UNregistered id, signed by an unknown key   -> loads, untrusted-key
 *   tampered          registered id, signed, then a byte changed  -> refused
 *   unsigned-trusted  registered id with no signature at all      -> refused (anti-downgrade)
 *
 * The last two are the ones worth having: they are the cases where the
 * difference between "checked" and "claims to be checked" shows up.
 *
 * hello-styled is deliberately left alone. It is the Phase 8 artifact proving
 * `buildPackage` produces a loadable package, its id is not registered, and
 * it must keep loading unsigned — otherwise this phase would have quietly
 * made unsigned packages unloadable, which is not what it claims to do.
 */
import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
  SIGNATURE_FILENAME,
} from '@openmini/shared';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const miniappsDir = join(scriptDir, '..', 'public', 'miniapps');
const generatedDir = join(scriptDir, '..', 'src', 'miniapp', 'fixtures', 'generated');

/** Ids are registered in the trust config; see TRUSTED_IDS below. */
const SIGNED_TRUSTED_ID = 'com.openmini.signed-trusted';
const TAMPERED_ID = 'com.openmini.tampered';
const UNSIGNED_TRUSTED_ID = 'com.openmini.unsigned-trusted';
/** Deliberately absent from the trust config. */
const SIGNED_UNTRUSTED_ID = 'com.openmini.signed-untrusted';

function manifestFor(id: string, name: string): string {
  // Written with the same shape and spacing the CLI emits, and copied
  // through byte for byte below, because its digest is what gets signed.
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id,
      name,
      version: '1.0.0',
      entry: 'index.html',
      permissions: [],
    },
    null,
    2,
  )}\n`;
}

function documentFor(label: string): string {
  // No inline script, so no CSP script hash is needed: these fixtures exist
  // to exercise the *integrity* path, and a bridge handshake would only add
  // a second reason for them to fail.
  return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${label}</title></head>
<body><h1 id="fixture">${label}</h1></body>
</html>
`;
}

interface FixtureSpec {
  dir: string;
  id: string;
  /** Omitted for the unsigned fixture. */
  sign?: 'trusted' | 'untrusted';
  /** Rewrite the entry document *after* signing, leaving a valid signature over stale bytes. */
  tamperAfterSigning?: boolean;
}

const FIXTURES: readonly FixtureSpec[] = [
  { dir: 'signed-trusted', id: SIGNED_TRUSTED_ID, sign: 'trusted' },
  { dir: 'signed-untrusted', id: SIGNED_UNTRUSTED_ID, sign: 'untrusted' },
  { dir: 'tampered', id: TAMPERED_ID, sign: 'trusted', tamperAfterSigning: true },
  { dir: 'unsigned-trusted', id: UNSIGNED_TRUSTED_ID },
];

async function main(): Promise<void> {
  const trusted = await generateSigningKeyPair();
  const untrusted = await generateSigningKeyPair();

  for (const fixture of FIXTURES) {
    const servedDir = join(miniappsDir, fixture.dir);
    rmSync(servedDir, { recursive: true, force: true });
    mkdirSync(servedDir, { recursive: true });

    const manifest = manifestFor(fixture.id, fixture.dir);
    const document = documentFor(fixture.dir);
    writeFileSync(join(servedDir, 'openmini.json'), manifest, 'utf8');
    writeFileSync(join(servedDir, 'index.html'), document, 'utf8');

    if (fixture.sign) {
      const key = fixture.sign === 'trusted' ? trusted : untrusted;
      // Digests are taken from what was just written, read back as bytes, so
      // the fixture is signed the same way `openmini sign` signs a package.
      const envelope = await signIntegrityPayload(
        {
          payloadVersion: INTEGRITY_PAYLOAD_VERSION,
          id: fixture.id,
          version: '1.0.0',
          files: {
            'openmini.json': await sha256Base64(readFileSync(join(servedDir, 'openmini.json'))),
            'index.html': await sha256Base64(readFileSync(join(servedDir, 'index.html'))),
          },
        },
        key.privateKey,
        key.publicKeySpki,
      );
      writeFileSync(
        join(servedDir, SIGNATURE_FILENAME),
        serializeSignatureEnvelope(envelope),
        'utf8',
      );
    }

    if (fixture.tamperAfterSigning) {
      // The realistic attack: the signature is genuine and verifies, but the
      // bytes it covers are no longer the bytes being served. Only the
      // per-resource digest check catches this.
      writeFileSync(
        join(servedDir, 'index.html'),
        documentFor(fixture.dir).replace('</body>', '<script>window.pwned = true;</script></body>'),
        'utf8',
      );
    }

    console.log(`signed fixture: ${servedDir}`);
  }

  // The host imports this. Generated rather than hand-written because the
  // key it names does not exist until the line above ran.
  const trustConfig = `// GENERATED by scripts/build-signed-fixtures.ts -- do not edit.
//
// The public half of an ephemeral key generated at fixture-build time. It is
// a public key, so committing it would be harmless; it is generated instead
// because the private half must not exist anywhere after this build, and a
// checked-in pair is how that stops being true.
import type { PackageTrustStore } from '@openmini/runtime';

const TRUSTED_PUBLIC_KEY = '${bytesToBase64(trusted.publicKeySpki)}';

/**
 * Ids this host claims to know the owner of. A package claiming one of these
 * must be signed by the key above or it does not load -- unsigned included.
 */
export const FIXTURE_TRUST_STORE: PackageTrustStore = {
  '${SIGNED_TRUSTED_ID}': [TRUSTED_PUBLIC_KEY],
  '${TAMPERED_ID}': [TRUSTED_PUBLIC_KEY],
  '${UNSIGNED_TRUSTED_ID}': [TRUSTED_PUBLIC_KEY],
};

export const FIXTURE_TRUSTED_KEY_ID = '${trusted.keyId}';
`;

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'trustConfig.ts'), trustConfig, 'utf8');
  console.log(`trust config written to ${join(generatedDir, 'trustConfig.ts')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
