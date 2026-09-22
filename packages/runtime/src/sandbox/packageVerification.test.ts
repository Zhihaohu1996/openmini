import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
} from '@openmini/shared';
import type { SigningKeyPair } from '@openmini/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { verifyPackage } from './packageVerification';
import type { PackageTrustStore } from './packageVerification';

const BASE_URL = 'https://cdn.example.com/apps/demo/';
const APP_ID = 'com.example.demo';
const APP_VERSION = '1.0.0';

const MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: APP_ID,
  name: 'Demo',
  version: APP_VERSION,
  entry: 'index.html',
  permissions: [],
});
const MANIFEST_BYTES = new TextEncoder().encode(MANIFEST_JSON);
const ENTRY_DIGEST = 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';

let publisher: SigningKeyPair;
let attacker: SigningKeyPair;
let manifestDigest: string;

beforeAll(async () => {
  publisher = await generateSigningKeyPair();
  attacker = await generateSigningKeyPair();
  manifestDigest = await sha256Base64(MANIFEST_BYTES);
});

async function signature(
  key: SigningKeyPair,
  overrides: { id?: string; version?: string; files?: Record<string, string> } = {},
): Promise<string> {
  const envelope = await signIntegrityPayload(
    {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id: overrides.id ?? APP_ID,
      version: overrides.version ?? APP_VERSION,
      files: overrides.files ?? { 'openmini.json': manifestDigest, 'index.html': ENTRY_DIGEST },
    },
    key.privateKey,
    key.publicKeySpki,
  );
  return serializeSignatureEnvelope(envelope);
}

const trustStoreFor = (key: SigningKeyPair): PackageTrustStore => ({
  [APP_ID]: [bytesToBase64(key.publicKeySpki)],
});

const run = (signatureText: string | undefined, trustStore?: PackageTrustStore) =>
  verifyPackage({
    baseUrl: BASE_URL,
    manifestId: APP_ID,
    manifestVersion: APP_VERSION,
    manifestBytes: MANIFEST_BYTES,
    signatureText,
    trustStore,
  });

describe('unregistered ids', () => {
  it('loads an unsigned package as unsigned', async () => {
    // The host has expressed no opinion about who owns this id, so there is
    // nothing to fail closed against.
    const result = await run(undefined);
    expect(result).toEqual({
      ok: true,
      provenance: { baseUrl: BASE_URL, identity: { verified: false, reason: 'unsigned' } },
    });
  });

  it('loads a package signed by an unknown key as untrusted-key, not verified', async () => {
    const result = await run(await signature(attacker));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.identity).toEqual({ verified: false, reason: 'untrusted-key' });
  });

  it('still enforces digests for an untrusted-key package', async () => {
    // Content integrity and identity are different claims. A package that
    // is internally consistent with its own signature earns the first even
    // when it fails the second.
    const result = await run(await signature(attacker));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.digests?.['index.html']).toBe(ENTRY_DIGEST);
  });

  it('refuses a package whose signature does not verify', async () => {
    // The anti-downgrade core: a broken signature is never treated as
    // absent. If it were, tampering would be easier than deletion.
    const broken = (await signature(publisher)).replace(
      ENTRY_DIGEST,
      'sha256-' + 'A'.repeat(43) + '=',
    );
    const result = await run(broken);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/signature verification failed/);
  });
});

describe('registered ids fail closed', () => {
  it('refuses an unsigned package', async () => {
    // Reporting it as merely unverified and running it anyway would make
    // registration decorative: strip the signature, reach the weaker path.
    const result = await run(undefined, trustStoreFor(publisher));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/registered.*but is unsigned/);
  });

  it('refuses a package signed by a key the host did not register', async () => {
    const result = await run(await signature(attacker), trustStoreFor(publisher));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/signed by a key the host does not trust/);
  });

  it('accepts a package signed by the registered key, and reports it verified', async () => {
    const result = await run(await signature(publisher), trustStoreFor(publisher));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.identity).toEqual({
      verified: true,
      id: APP_ID,
      keyId: publisher.keyId,
    });
  });

  it('decides trust on key material, not on a matching keyId', async () => {
    // An attacker can copy a keyId; they cannot produce the private half of
    // somebody else's public key. The trust store holds full SPKI, so a
    // store listing only the publisher's keyId-shaped string trusts nobody.
    const keyIdOnlyStore: PackageTrustStore = { [APP_ID]: [publisher.keyId] };
    const result = await run(await signature(publisher), keyIdOnlyStore);
    expect(result.ok).toBe(false);
  });

  it('leaves other ids unaffected by one id being registered', async () => {
    const otherStore: PackageTrustStore = {
      'com.example.something-else': [bytesToBase64(publisher.publicKeySpki)],
    };
    const result = await run(undefined, otherStore);
    expect(result.ok).toBe(true);
  });
});

describe('binding the signature to the package', () => {
  it('refuses a signature issued for a different package id', async () => {
    // Otherwise a genuine signature for one package could be served with
    // another package's manifest: it verifies, its digests match its own
    // payload, and the host believes an identity nobody asserted.
    const result = await run(await signature(publisher, { id: 'com.example.other' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/signature is for "com.example.other"/);
  });

  it('refuses a signature issued for a different version', async () => {
    const result = await run(await signature(publisher, { version: '0.9.0' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/signature is for version "0\.9\.0"/);
  });

  it('refuses a signature that does not cover the manifest', async () => {
    // The manifest declares permissions and network domains. A signature
    // omitting it would attest to the code but leave what the code is
    // allowed to do unsigned.
    const result = await run(await signature(publisher, { files: { 'index.html': ENTRY_DIGEST } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/does not cover openmini\.json/);
  });

  it('refuses a manifest whose bytes do not match its signed digest', async () => {
    const result = await verifyPackage({
      baseUrl: BASE_URL,
      manifestId: APP_ID,
      manifestVersion: APP_VERSION,
      manifestBytes: new TextEncoder().encode(`${MANIFEST_JSON} `),
      signatureText: await signature(publisher),
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toMatch(/openmini\.json does not match its signed digest/);
  });

  it('is unaffected by the signature file being reformatted', async () => {
    // The payload is opaque to the signature, so only the payload string is
    // covered and the envelope's own layout is free.
    const reformatted = JSON.stringify(JSON.parse(await signature(publisher)), null, 6);
    const result = await run(reformatted, trustStoreFor(publisher));
    expect(result.ok).toBe(true);
  });
});
