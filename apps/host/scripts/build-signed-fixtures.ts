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
import { assembleEntryDocument } from '@openmini/cli';
import { build } from 'esbuild';
import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
  SIGNATURE_FILENAME,
  TRUST_CONFIG_FILENAME,
  TRUST_CONFIG_VERSION,
} from '@openmini/shared';
import type { SigningKeyPair, TrustedKeyEntry } from '@openmini/shared';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const publicDir = join(scriptDir, '..', 'public');
const miniappsDir = join(publicDir, 'miniapps');
const generatedDir = join(scriptDir, '..', 'src', 'miniapp', 'fixtures', 'generated');

/**
 * One registered, usable key.
 *
 * `keyId` is written purely so a human opening the generated file can tell
 * the blobs apart. Nothing reads it — see `PackageTrustStore` — and the
 * revoked entries below deliberately carry one too, so the file exercises
 * the label on both statuses.
 */
const activeKey = (key: SigningKeyPair, label: string): TrustedKeyEntry => ({
  publicKey: bytesToBase64(key.publicKeySpki),
  status: 'active',
  keyId: label,
});

/** Ids are registered in the trust config; see TRUSTED_IDS below. */
const SIGNED_TRUSTED_ID = 'com.openmini.signed-trusted';
const TAMPERED_ID = 'com.openmini.tampered';
const UNSIGNED_TRUSTED_ID = 'com.openmini.unsigned-trusted';
/** Deliberately absent from the trust config. */
const SIGNED_UNTRUSTED_ID = 'com.openmini.signed-untrusted';

/**
 * The storage probe, in two variants. These are the only fixtures that can
 * actually reach the storage capability over a real bridge *while carrying
 * real provenance*, which is what Phase 10's browser evidence requires.
 *
 * The Phase 9 fixtures above carry no script, so they cannot reach the
 * bridge at all; `bridge-demo` can, but it is rendered through the host's
 * `?scenario=` path with no provenance, landing in the embedded tier — the
 * one tier Phase 10 deliberately leaves alone. Neither can show that a
 * verified and an unverified package get different namespaces.
 */
const STORAGE_SIGNED_ID = 'com.openmini.storage-signed';
/** Deliberately unregistered, so it lands in the origin tier. */
const STORAGE_UNSIGNED_ID = 'com.openmini.storage-unsigned';

/**
 * Phase 11's two lifecycle fixtures.
 *
 * `revoked-key` is registered with exactly one key, marked `revoked`, and
 * is signed by that key. It must be refused — and refused *as revoked*,
 * not as an untrusted key and not as unsigned, because those three have
 * three different remedies.
 *
 * `storage-rotated` is the rotation case, and it is a storage probe rather
 * than an inert document on purpose: rotation's whole claim is that the
 * verified namespace is `v1:id:<id>` and names the id rather than the
 * signing key, so proving it needs a package that can actually write to
 * IndexedDB. Its id registers the original key as `revoked` and a
 * successor as `active`, and the package is signed by the successor.
 */
/**
 * Phase 12's identity fixtures, and the only pair that can show the gate.
 * Same Mini App source, same `user` permission; one id is registered and
 * signed by a registered key and the other is neither, so the only
 * difference between them is the identity the host establishes.
 */
const USER_SIGNED_ID = 'com.openmini.user-signed';
/** Deliberately unregistered, so it stays in the origin tier. */
const USER_UNSIGNED_ID = 'com.openmini.user-unsigned';
/** Registered and signed, but never declares the `user` permission. */
const USER_UNPERMITTED_ID = 'com.openmini.user-unpermitted';

const REVOKED_ID = 'com.openmini.revoked-key';
const ROTATED_ID = 'com.openmini.storage-rotated';

function manifestFor(id: string, name: string, permissions: string[] = []): string {
  // Written with the same shape and spacing the CLI emits, and copied
  // through byte for byte below, because its digest is what gets signed.
  return `${JSON.stringify(
    {
      schemaVersion: 1,
      id,
      name,
      version: '1.0.0',
      entry: 'index.html',
      permissions,
    },
    null,
    2,
  )}\n`;
}

/**
 * The storage probe's entry document, built the way a real package is: its
 * Mini App source bundled by esbuild, then inlined and hashed by the CLI's
 * own `assembleEntryDocument`, so the CSP binds the script that actually
 * ships. Hand-rolling this would produce a document the sandbox refuses to
 * run, and the failure would look like a Phase 10 bug rather than a fixture
 * bug.
 */
async function buildProbeDocument(probe: ProbeKind, label: string): Promise<string> {
  const entry = join(
    scriptDir,
    '..',
    'src',
    'miniapp',
    'fixtures',
    probe,
    'miniapp-src',
    'main.ts',
  );
  const bundled = await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: false,
    legalComments: 'none',
  });
  const script = bundled.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error(`esbuild produced no output for the ${probe} fixture`);
  }

  // `#probe-id` lets a spec confirm *which* package it is looking at, which
  // matters when two builds share one id across two origins.
  const shell = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>${label}</title></head>
<body>
<h1 id="probe-id">${label}</h1>
<p id="probe-ready">pending</p>
<p id="probe-user-id">pending</p>
<p id="probe-user-name">pending</p>
<script></script>
</body>
</html>
`;
  return assembleEntryDocument({ html: shell, script }).html;
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

type ProbeKind = 'storage-probe' | 'user-probe';

interface FixtureSpec {
  dir: string;
  id: string;
  /** Omitted for the unsigned fixture. */
  sign?: 'trusted' | 'untrusted' | 'revoked' | 'successor';
  /** Rewrite the entry document *after* signing, leaving a valid signature over stale bytes. */
  tamperAfterSigning?: boolean;
  /** Build a real SDK-backed probe instead of the inert integrity fixture. */
  probe?: ProbeKind;
  /** Manifest permissions. Defaults to the probe's own, or none. */
  permissions?: string[];
}

/**
 * A probe declares the capability it probes, unless the fixture overrides
 * it -- which `user-unpermitted` does, to be verified and unpermitted at
 * the same time.
 */
function permissionsFor(fixture: FixtureSpec): string[] {
  if (fixture.permissions !== undefined) return fixture.permissions;
  if (fixture.probe === 'storage-probe') return ['storage'];
  if (fixture.probe === 'user-probe') return ['user'];
  return [];
}

const FIXTURES: readonly FixtureSpec[] = [
  { dir: 'signed-trusted', id: SIGNED_TRUSTED_ID, sign: 'trusted' },
  { dir: 'signed-untrusted', id: SIGNED_UNTRUSTED_ID, sign: 'untrusted' },
  { dir: 'tampered', id: TAMPERED_ID, sign: 'trusted', tamperAfterSigning: true },
  { dir: 'unsigned-trusted', id: UNSIGNED_TRUSTED_ID },
  { dir: 'storage-signed', id: STORAGE_SIGNED_ID, sign: 'trusted', probe: 'storage-probe' },
  { dir: 'storage-unsigned', id: STORAGE_UNSIGNED_ID, probe: 'storage-probe' },
  { dir: 'revoked-key', id: REVOKED_ID, sign: 'revoked' },
  { dir: 'storage-rotated', id: ROTATED_ID, sign: 'successor', probe: 'storage-probe' },
  { dir: 'user-signed', id: USER_SIGNED_ID, sign: 'trusted', probe: 'user-probe' },
  { dir: 'user-unsigned', id: USER_UNSIGNED_ID, probe: 'user-probe' },
  // Verified, and silent about `user`. The dispatcher must refuse it even
  // though its identity is established -- the two gates are independent.
  {
    dir: 'user-unpermitted',
    id: USER_UNPERMITTED_ID,
    sign: 'trusted',
    probe: 'user-probe',
    permissions: [],
  },
];

async function main(): Promise<void> {
  const trusted = await generateSigningKeyPair();
  const untrusted = await generateSigningKeyPair();
  /** Registered for REVOKED_ID and for ROTATED_ID, revoked in both. */
  const revoked = await generateSigningKeyPair();
  /** The key ROTATED_ID rotated *to*. Registered active. */
  const successor = await generateSigningKeyPair();

  const keyPairs = { trusted, untrusted, revoked, successor };

  for (const fixture of FIXTURES) {
    const servedDir = join(miniappsDir, fixture.dir);
    rmSync(servedDir, { recursive: true, force: true });
    mkdirSync(servedDir, { recursive: true });

    const manifest = manifestFor(fixture.id, fixture.dir, permissionsFor(fixture));
    const document = fixture.probe
      ? await buildProbeDocument(fixture.probe, fixture.dir)
      : documentFor(fixture.dir);
    writeFileSync(join(servedDir, 'openmini.json'), manifest, 'utf8');
    writeFileSync(join(servedDir, 'index.html'), document, 'utf8');

    if (fixture.sign) {
      const key = keyPairs[fixture.sign];
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

  // The real trust configuration, in the real format, served beside the app
  // and read by the host at startup. Generated rather than committed because
  // the keys it names do not exist until the lines above ran -- and that is
  // now the only reason, which is the point of this phase: these fixtures
  // are one instance of `openmini.trust.json`, not the only trust
  // configuration that can exist.
  const trustConfigJson = {
    trustConfigVersion: TRUST_CONFIG_VERSION,
    packages: {
      [SIGNED_TRUSTED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      [TAMPERED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      [UNSIGNED_TRUSTED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      [STORAGE_SIGNED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      // Registered, and nothing may sign it. Still registered: an unsigned
      // package claiming this id must still fail closed, which is what stops
      // revoking every key from being a way back to the permissive path.
      [USER_SIGNED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      [USER_UNPERMITTED_ID]: { keys: [activeKey(trusted, 'fixture-build')] },
      [REVOKED_ID]: {
        keys: [
          {
            publicKey: bytesToBase64(revoked.publicKeySpki),
            status: 'revoked',
            keyId: 'retired-key',
          },
        ],
      },
      // Rotation, in the state an operator leaves behind: the compromised
      // key retained as `revoked` rather than deleted, so a package still
      // signed by it is refused as revoked instead of as unregistered.
      [ROTATED_ID]: {
        keys: [
          {
            publicKey: bytesToBase64(revoked.publicKeySpki),
            status: 'revoked',
            keyId: 'retired-key',
          },
          activeKey(successor, 'successor-key'),
        ],
      },
    },
  };

  writeFileSync(
    join(publicDir, TRUST_CONFIG_FILENAME),
    `${JSON.stringify(trustConfigJson, null, 2)}\n`,
    'utf8',
  );
  console.log(`trust config written to ${join(publicDir, TRUST_CONFIG_FILENAME)}`);

  // A deliberately broken configuration, so the host's fail-closed path can
  // be driven through the real app rather than simulated. It is rejected for
  // two reasons at once -- an unsupported version and an unknown field --
  // because a file that fails for only one reason could pass if a single
  // check regressed.
  writeFileSync(
    join(publicDir, 'openmini.trust.invalid.json'),
    `${JSON.stringify({ trustConfigVersion: 99, packages: {}, notAfter: '2027-01-01' }, null, 2)}\n`,
    'utf8',
  );
  console.log(`invalid trust config written to ${join(publicDir, 'openmini.trust.invalid.json')}`);

  // Ids and keyIds the e2e specs refer to. No trust store here any more: the
  // JSON above is the configuration, and a second copy compiled into the
  // bundle is exactly the drift this phase removed.
  const generatedModule = `// GENERATED by scripts/build-signed-fixtures.ts -- do not edit.
//
// Fixture ids and the keyIds of the ephemeral keys this build signed with.
// The trust configuration itself is public/${TRUST_CONFIG_FILENAME}, which the
// host fetches at startup; nothing here decides trust.

export const STORAGE_PROBE_SIGNED_ID = '${STORAGE_SIGNED_ID}';
export const STORAGE_PROBE_UNSIGNED_ID = '${STORAGE_UNSIGNED_ID}';
export const USER_PROBE_SIGNED_ID = '${USER_SIGNED_ID}';
export const USER_PROBE_UNSIGNED_ID = '${USER_UNSIGNED_ID}';
export const USER_PROBE_UNPERMITTED_ID = '${USER_UNPERMITTED_ID}';
export const REVOKED_KEY_ID = '${REVOKED_ID}';
export const STORAGE_ROTATED_ID = '${ROTATED_ID}';

export const FIXTURE_TRUSTED_KEY_ID = '${trusted.keyId}';
export const FIXTURE_REVOKED_KEY_ID = '${revoked.keyId}';
export const FIXTURE_SUCCESSOR_KEY_ID = '${successor.keyId}';
`;

  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, 'trustConfig.ts'), generatedModule, 'utf8');
  console.log(`fixture ids written to ${join(generatedDir, 'trustConfig.ts')}`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
