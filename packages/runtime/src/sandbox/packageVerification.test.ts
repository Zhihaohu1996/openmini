import {
  bytesToBase64,
  generateSigningKeyPair,
  INTEGRITY_PAYLOAD_VERSION,
  serializeSignatureEnvelope,
  sha256Base64,
  signIntegrityPayload,
} from '@openmini/shared';
import type { SigningKeyPair, TrustedKeyEntry } from '@openmini/shared';
import { beforeAll, describe, expect, it } from 'vitest';
import { normalizeTrustEntry, verifyPackage } from './packageVerification';
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

/**
 * Phase 11 W2. The trust store grows a richer entry form without changing a
 * single load outcome; W3 is where a revoked key starts refusing. See
 * docs/plans/phase-11.md.
 */

describe('normalizeTrustEntry', () => {
  it('reads a bare string as an active key', () => {
    // The entire backward-compatibility story, in one line: before Phase 11
    // there was no way to register a key except as one that may sign, so
    // that is what a legacy entry has to keep meaning.
    expect(normalizeTrustEntry('SPKI')).toEqual({ publicKey: 'SPKI', status: 'active' });
  });

  it('passes an entry through untouched, label and all', () => {
    const entry: TrustedKeyEntry = { publicKey: 'SPKI', status: 'revoked', keyId: 'old-laptop' };
    expect(normalizeTrustEntry(entry)).toEqual(entry);
  });
});

describe('legacy bare-string trust entries keep working', () => {
  it('verifies a package signed by a legacy-registered key', async () => {
    const result = await run(await signature(publisher), {
      [APP_ID]: [bytesToBase64(publisher.publicKeySpki)],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.identity).toEqual({
      verified: true,
      id: APP_ID,
      keyId: publisher.keyId,
    });
  });

  it('still fails closed against a key the legacy store does not list', async () => {
    const result = await run(await signature(attacker), {
      [APP_ID]: [bytesToBase64(publisher.publicKeySpki)],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('untrusted-key');
  });

  it('accepts the two spellings side by side in one entry', async () => {
    // A host part-way through rewriting its configuration is a real state,
    // and it must not be one where trust silently narrows.
    const result = await run(await signature(publisher), {
      [APP_ID]: [
        bytesToBase64(attacker.publicKeySpki),
        { publicKey: bytesToBase64(publisher.publicKeySpki), status: 'active' },
      ],
    });

    expect(result.ok).toBe(true);
  });
});

describe('the richer entry form', () => {
  it('verifies an active key exactly as the legacy spelling does', async () => {
    const result = await run(await signature(publisher), {
      [APP_ID]: [{ publicKey: bytesToBase64(publisher.publicKeySpki), status: 'active' }],
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.identity).toEqual({
      verified: true,
      id: APP_ID,
      keyId: publisher.keyId,
    });
  });

  it('decides trust on the key material even when a keyId label says otherwise', async () => {
    // The label is for a human reading the host's configuration. Here it
    // names the publisher while the key material is the attacker's, and the
    // publisher's genuine signature is still refused -- because nothing in
    // the decision reads the label.
    const result = await run(await signature(publisher), {
      [APP_ID]: [
        {
          publicKey: bytesToBase64(attacker.publicKeySpki),
          status: 'active',
          keyId: publisher.keyId,
        },
      ],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('untrusted-key');
  });

  it('registers the id even when it carries no keys at all', async () => {
    // Registration is the presence of the id, not the presence of a usable
    // key. An id registered with nothing that may sign it still fails closed
    // -- the degenerate case of every key being revoked.
    const result = await run(undefined, { [APP_ID]: [] });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('unsigned-registered');
  });
});

describe('every refusal carries a code, and none of the messages moved', () => {
  it('codes an unsigned registered package', async () => {
    const result = await run(undefined, trustStoreFor(publisher));
    expect(result).toMatchObject({ ok: false, code: 'unsigned-registered' });
  });

  it('codes a signature that does not verify', async () => {
    const broken = (await signature(publisher)).replace(
      ENTRY_DIGEST,
      'sha256-' + 'A'.repeat(43) + '=',
    );
    expect(await run(broken)).toMatchObject({ ok: false, code: 'signature-invalid' });
  });

  it('codes an id mismatch', async () => {
    const result = await run(await signature(publisher, { id: 'com.example.other' }));
    expect(result).toMatchObject({ ok: false, code: 'id-mismatch' });
  });

  it('codes a version mismatch', async () => {
    const result = await run(await signature(publisher, { version: '0.9.0' }));
    expect(result).toMatchObject({ ok: false, code: 'version-mismatch' });
  });

  it('codes a signature that does not cover the manifest', async () => {
    const result = await run(await signature(publisher, { files: { 'index.html': ENTRY_DIGEST } }));
    expect(result).toMatchObject({ ok: false, code: 'manifest-not-covered' });
  });

  it('codes a manifest that does not match its signed digest', async () => {
    const result = await verifyPackage({
      baseUrl: BASE_URL,
      manifestId: APP_ID,
      manifestVersion: APP_VERSION,
      manifestBytes: new TextEncoder().encode(`${MANIFEST_JSON} `),
      signatureText: await signature(publisher),
    });
    expect(result).toMatchObject({ ok: false, code: 'manifest-digest-mismatch' });
  });

  it('codes an untrusted key', async () => {
    const result = await run(await signature(attacker), trustStoreFor(publisher));
    expect(result).toMatchObject({ ok: false, code: 'untrusted-key' });
  });
});

describe('what W2 deliberately does not do yet', () => {
  it('does not yet refuse a revoked key', async () => {
    // Pinned rather than left implicit, the way Phase 9 pinned the storage
    // id collision: W3 is the one commit where this flips, and breaking this
    // test is how it announces itself.
    //
    // Nothing can reach this state in a running host today -- the trust
    // config that produces a revoked entry is not wired to the load path
    // until W6 -- so this is a property of the type migration, not a gap a
    // deployed host has.
    const result = await run(await signature(publisher), {
      [APP_ID]: [{ publicKey: bytesToBase64(publisher.publicKeySpki), status: 'revoked' }],
    });

    expect(result.ok).toBe(true);
  });
});
