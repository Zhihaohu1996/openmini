import { beforeAll, describe, expect, it } from 'vitest';
import { base64ToBytes, bytesToBase64 } from './crypto';
import {
  INTEGRITY_ALGORITHM,
  INTEGRITY_PAYLOAD_VERSION,
  SIGNATURE_ENVELOPE_VERSION,
  SIGNATURE_FILENAME,
  computeKeyId,
  generateSigningKeyPair,
  parseSignatureEnvelope,
  serializeIntegrityPayload,
  serializeSignatureEnvelope,
  signIntegrityPayload,
  verifySignatureEnvelope,
  verifySignatureFile,
} from './integrity';
import type { IntegrityPayload, SignatureEnvelope, SigningKeyPair } from './integrity';

const DIGEST_A = 'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=';
const DIGEST_B = 'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=';

const payload: IntegrityPayload = {
  payloadVersion: INTEGRITY_PAYLOAD_VERSION,
  id: 'com.example.app',
  version: '1.0.0',
  files: { 'index.html': DIGEST_A, 'openmini.json': DIGEST_B },
};

let signer: SigningKeyPair;
let other: SigningKeyPair;
let envelope: SignatureEnvelope;

beforeAll(async () => {
  signer = await generateSigningKeyPair();
  other = await generateSigningKeyPair();
  envelope = await signIntegrityPayload(payload, signer.privateKey, signer.publicKeySpki);
});

const reasonFor = async (env: SignatureEnvelope): Promise<string> => {
  const result = await verifySignatureEnvelope(env);
  if (result.ok) throw new Error('expected verification to fail, but it succeeded');
  return result.reason;
};

describe('sign/verify round trip', () => {
  it('verifies a signature it just produced', async () => {
    const result = await verifySignatureEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.payload).toEqual(payload);
    expect(result.keyId).toBe(signer.keyId);
  });

  it('returns the complete key material, which is what a caller decides trust on', async () => {
    // keyId is a label. A trust store matches on these bytes.
    const result = await verifySignatureEnvelope(envelope);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKeySpki).toEqual(signer.publicKeySpki);
  });

  it('round-trips through the serialized file form', async () => {
    const result = await verifySignatureFile(serializeSignatureEnvelope(envelope));
    expect(result.ok).toBe(true);
  });

  it('produces a different signature each time, because ECDSA is randomized', async () => {
    // Recorded because it is the reason `build` stays unsigned: build output
    // must be byte-reproducible, and a signature never is.
    const again = await signIntegrityPayload(payload, signer.privateKey, signer.publicKeySpki);
    expect(again.signature).not.toBe(envelope.signature);
    // ...and both verify.
    expect((await verifySignatureEnvelope(again)).ok).toBe(true);
  });

  it('signs the payload text verbatim, so reformatting the envelope is harmless', async () => {
    // The point of an opaque payload: only the `payload` string is covered,
    // so indentation and key order elsewhere in the file cannot break it.
    const reformatted = JSON.stringify(JSON.parse(serializeSignatureEnvelope(envelope)), null, 8);
    expect((await verifySignatureFile(reformatted)).ok).toBe(true);
  });
});

describe('tampering', () => {
  it('rejects a payload edited after signing', async () => {
    const tampered: SignatureEnvelope = {
      ...envelope,
      payload: envelope.payload.replace(DIGEST_A, DIGEST_B),
    };
    expect(await reasonFor(tampered)).toMatch(/signature does not match the payload/);
  });

  it('rejects a signature from a different key', async () => {
    const wrongKey = await signIntegrityPayload(payload, other.privateKey, other.publicKeySpki);
    // Swap in the original signer's identity but keep the other key's signature.
    const mismatched: SignatureEnvelope = {
      ...wrongKey,
      keyId: signer.keyId,
      publicKey: bytesToBase64(signer.publicKeySpki),
    };
    expect(await reasonFor(mismatched)).toMatch(/signature does not match the payload/);
  });

  it('rejects an envelope whose keyId does not name its own publicKey', async () => {
    // Not a trust check -- trust is decided on key material -- but a
    // misleading identifier must not reach logs and error messages.
    expect(await reasonFor({ ...envelope, keyId: other.keyId })).toMatch(
      /keyId does not match publicKey/,
    );
  });

  it('rejects a substituted key even though the substitute signs correctly', async () => {
    // The attack this format cannot stop on its own: anyone can sign a
    // package with their own key and present a self-consistent envelope.
    // Verification succeeds; it is the *trust store* that must reject it,
    // which is why the key material is returned to the caller.
    const attacker = await signIntegrityPayload(payload, other.privateKey, other.publicKeySpki);
    const result = await verifySignatureEnvelope(attacker);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.publicKeySpki).not.toEqual(signer.publicKeySpki);
  });

  it('rejects a DER-wrapped signature with an explanatory message', async () => {
    // OpenSSL emits DER; WebCrypto wants raw r||s. This is the single most
    // likely interop mistake, so it gets a named error rather than a bare
    // verification failure.
    const der = new Uint8Array(70);
    expect(await reasonFor({ ...envelope, signature: bytesToBase64(der) })).toMatch(
      /raw bytes \(r\|\|s\).*DER/s,
    );
  });

  it('rejects a truncated signature', async () => {
    const short = base64ToBytes(envelope.signature).slice(0, 32);
    expect(await reasonFor({ ...envelope, signature: bytesToBase64(short) })).toMatch(
      /must be 64 raw bytes/,
    );
  });

  it('rejects a publicKey that is not a P-256 SPKI key', async () => {
    const junk = bytesToBase64(new Uint8Array([1, 2, 3, 4]));
    expect(await reasonFor({ ...envelope, publicKey: junk })).toMatch(/not a valid P-256 SPKI key/);
  });
});

describe('parseSignatureEnvelope', () => {
  const validFile = (overrides: Record<string, unknown> = {}): string =>
    JSON.stringify({
      sigVersion: SIGNATURE_ENVELOPE_VERSION,
      algorithm: INTEGRITY_ALGORITHM,
      keyId: 'abc-_123',
      publicKey: 'AAAA',
      payload: '{}',
      signature: 'AAAA',
      ...overrides,
    });

  const parseReason = (raw: string): string => {
    const result = parseSignatureEnvelope(raw);
    if (result.ok) throw new Error('expected parsing to fail, but it succeeded');
    return result.reason;
  };

  it('leaves the payload opaque, as an unparsed string', () => {
    // Structural parsing must not look inside the payload: nothing may read
    // it before the signature over it has been checked.
    const result = parseSignatureEnvelope(validFile({ payload: 'not json at all' }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.payload).toBe('not json at all');
  });

  it('reports malformed JSON rather than throwing', () => {
    expect(parseReason('{nope')).toMatch(/invalid JSON/);
  });

  it('rejects an unsupported sigVersion', () => {
    expect(parseReason(validFile({ sigVersion: 2 }))).toMatch(/unsupported sigVersion/);
  });

  it('rejects a different algorithm', () => {
    // No algorithm agility: a negotiable algorithm field is a downgrade surface.
    expect(parseReason(validFile({ algorithm: 'ed25519' }))).toMatch(
      /algorithm must be "ecdsa-p256-sha256"/,
    );
  });

  it('rejects unknown fields', () => {
    // An ignored `expires` is an expired signature honoured forever.
    expect(parseReason(validFile({ expires: '2030-01-01' }))).toMatch(
      /unknown field\(s\): expires/,
    );
  });

  it('rejects an empty payload', () => {
    expect(parseReason(validFile({ payload: '' }))).toMatch(/payload must be a non-empty string/);
  });

  it('rejects a keyId that is standard base64 rather than base64url', () => {
    expect(parseReason(validFile({ keyId: 'a+b/c=' }))).toMatch(/base64url/);
  });
});

describe('signed payload validation', () => {
  /** Signs arbitrary text as though it were a payload, to reach the post-verify parse. */
  const signRaw = async (payloadText: string): Promise<SignatureEnvelope> => {
    const signed = new TextEncoder().encode(payloadText);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer.privateKey,
        signed as unknown as ArrayBufferView<ArrayBuffer>,
      ),
    );
    return {
      sigVersion: SIGNATURE_ENVELOPE_VERSION,
      algorithm: INTEGRITY_ALGORITHM,
      keyId: await computeKeyId(signer.publicKeySpki),
      publicKey: bytesToBase64(signer.publicKeySpki),
      payload: payloadText,
      signature: bytesToBase64(signature),
    };
  };

  it(`rejects a payload listing ${SIGNATURE_FILENAME} among its own files`, async () => {
    // The signature file's bytes include the signature, so its digest could
    // never be computed before it existed. A payload claiming otherwise was
    // not produced by an honest signer, and ignoring the entry would leave a
    // verifier chasing an unsatisfiable digest.
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: INTEGRITY_PAYLOAD_VERSION,
        id: 'a',
        version: '1.0.0',
        files: { 'index.html': DIGEST_A, [SIGNATURE_FILENAME]: DIGEST_B },
      }),
    );
    expect(await reasonFor(env)).toMatch(new RegExp(`must not list ${SIGNATURE_FILENAME}`));
  });

  it('rejects an empty file map', async () => {
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: INTEGRITY_PAYLOAD_VERSION,
        id: 'a',
        version: '1.0.0',
        files: {},
      }),
    );
    expect(await reasonFor(env)).toMatch(/at least one file/);
  });

  it.each([
    ['../escape.html', /relative path segment/],
    ['./same.html', /relative path segment/],
    ['/absolute.html', /absolute path/],
    ['C:/windows.html', /drive-letter path/],
    ['dir\\file.html', /backslash in path/],
    ['dir//file.html', /empty path segment/],
  ])('rejects the file path %j', async (path, expected) => {
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: INTEGRITY_PAYLOAD_VERSION,
        id: 'a',
        version: '1.0.0',
        files: { [path]: DIGEST_A },
      }),
    );
    expect(await reasonFor(env)).toMatch(expected);
  });

  it('rejects a digest that is not sha256-<base64>', async () => {
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: INTEGRITY_PAYLOAD_VERSION,
        id: 'a',
        version: '1.0.0',
        files: { 'a.html': 'sha512-nope' },
      }),
    );
    expect(await reasonFor(env)).toMatch(/must be a "sha256-<base64>" digest/);
  });

  it('rejects an unsupported payloadVersion', async () => {
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: 99,
        id: 'a',
        version: '1.0.0',
        files: { 'a.html': DIGEST_A },
      }),
    );
    expect(await reasonFor(env)).toMatch(/unsupported payloadVersion/);
  });

  it('rejects unknown payload fields', async () => {
    const env = await signRaw(
      JSON.stringify({
        payloadVersion: INTEGRITY_PAYLOAD_VERSION,
        id: 'a',
        version: '1.0.0',
        files: { 'a.html': DIGEST_A },
        grantAllPermissions: true,
      }),
    );
    // A field this reader drops is a field a future reader enforces.
    expect(await reasonFor(env)).toMatch(/unknown field\(s\): grantAllPermissions/);
  });

  it('rejects a signed payload that is not JSON at all', async () => {
    const env = await signRaw('definitely not json');
    // Properly signed, so this is signer error rather than tampering, and
    // the message says so.
    expect(await reasonFor(env)).toMatch(/signed payload is not valid JSON/);
  });
});

describe('serializeIntegrityPayload', () => {
  it('sorts file paths so a signer does not emit a different string each run', () => {
    const text = serializeIntegrityPayload({
      ...payload,
      files: { 'openmini.json': DIGEST_B, 'index.html': DIGEST_A },
    });
    expect(text.indexOf('index.html')).toBeLessThan(text.indexOf('openmini.json'));
  });

  it('does not affect verifiability, because the payload is opaque', async () => {
    // Any serialization verifies, as long as it is the one that was signed.
    const odd = `   ${JSON.stringify({ payloadVersion: 1, id: 'a', version: '1.0.0', files: { 'a.html': DIGEST_A } })}`;
    const signed = new TextEncoder().encode(odd);
    const signature = new Uint8Array(
      await crypto.subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signer.privateKey,
        signed as unknown as ArrayBufferView<ArrayBuffer>,
      ),
    );
    const result = await verifySignatureEnvelope({
      sigVersion: SIGNATURE_ENVELOPE_VERSION,
      algorithm: INTEGRITY_ALGORITHM,
      keyId: signer.keyId,
      publicKey: bytesToBase64(signer.publicKeySpki),
      payload: odd,
      signature: bytesToBase64(signature),
    });
    expect(result.ok).toBe(true);
  });
});

describe('computeKeyId', () => {
  it('is derived from the key, so two people naming one key agree', async () => {
    expect(await computeKeyId(signer.publicKeySpki)).toBe(signer.keyId);
  });

  it('differs between keys', async () => {
    expect(signer.keyId).not.toBe(other.keyId);
  });
});
