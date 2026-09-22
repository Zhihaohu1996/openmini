/**
 * The detached package signature: `openmini.sig.json`, and the verifier for
 * it.
 *
 * This lives in @openmini/shared for the reason `crypto.ts` and `csp.ts` do:
 * the Node CLI produces these files and the browser runtime consumes them,
 * and a producer and consumer that disagree about the format would fail
 * closed on honest packages while proving nothing about dishonest ones.
 *
 * ## The payload is opaque to the signature
 *
 * The envelope carries `payload` as a *string*, and the signature covers the
 * UTF-8 bytes of exactly that string. The verifier checks the signature
 * first and parses the payload only afterwards.
 *
 * This is the whole design, and it is worth being explicit about what it
 * buys. The alternative — signing a structure, and re-deriving the signed
 * bytes from a parse — forces producer and consumer to agree on a
 * canonicalization: key order, whitespace, number formatting, string escapes,
 * and a sort whose collation must be identical in two runtimes. Every one of
 * those is a way for a valid package to fail verification on somebody else's
 * machine. Treating the payload as opaque removes the entire class: there is
 * nothing to canonicalize, because the bytes that were signed are the bytes
 * that are stored.
 *
 * It also removes the JSON-duplicate-key hazard. `JSON.parse` silently keeps
 * the last of `{"a":1,"a":2}`, so a verifier that hashes text and acts on a
 * parse can check one value and use another. Here the signature covers the
 * text, and the parse happens after the signature is already known good, so
 * whatever the parse yields is what the signer signed.
 *
 * ## keyId identifies; the key itself is the trust anchor
 *
 * `keyId` is a label — it exists so logs, errors and key rotation have
 * something short to name. It is never what trust is decided on. A caller
 * deciding whether to trust a package compares the *complete SPKI public key
 * material* returned by `verifySignatureEnvelope` against its trust store.
 * Trusting a `keyId` string would be trusting an attacker-chosen field: it
 * costs nothing to claim someone else's.
 */

import { base64ToBytes, base64UrlEncode, bytesToBase64, sha256 } from './crypto';

/** Detached signature file, a sibling of `openmini.json` at the package root. */
export const SIGNATURE_FILENAME = 'openmini.sig.json';

/**
 * ECDSA over P-256 with SHA-256.
 *
 * Named as one string rather than a curve/hash/algorithm triple because
 * there is nothing to negotiate: a signature format with selectable parts is
 * a downgrade surface, and changing any part of this is a version bump.
 */
export const INTEGRITY_ALGORITHM = 'ecdsa-p256-sha256';

export const SIGNATURE_ENVELOPE_VERSION = 1;
export const INTEGRITY_PAYLOAD_VERSION = 1;

/** P-256 raw signatures are r||s, 32 bytes each. */
const SIGNATURE_BYTE_LENGTH = 64;

/** `sha256-` + base64 of 32 bytes, always 44 characters with padding. */
const DIGEST_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

const WEBCRYPTO_KEY_PARAMS = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const WEBCRYPTO_SIGN_PARAMS = { name: 'ECDSA', hash: 'SHA-256' } as const;

/**
 * What the signature actually vouches for.
 *
 * `id` and `version` are bound alongside the file list, not left implicit.
 * Without them the signature is transplantable: lift a signature file onto a
 * package that claims a different `id` and the digests still match, because
 * the files are the same. Binding identity is what lets a verifier answer
 * "is this package entitled to the id it claims", which docs/security/bridge.md
 * currently records as an open question against storage.
 */
export interface IntegrityPayload {
  readonly payloadVersion: number;
  readonly id: string;
  readonly version: string;
  /** Package-relative POSIX path -> `sha256-<base64>` of that file's bytes. */
  readonly files: Readonly<Record<string, string>>;
}

export interface SignatureEnvelope {
  readonly sigVersion: number;
  readonly algorithm: typeof INTEGRITY_ALGORITHM;
  /** Identifier only. Never the basis for a trust decision. */
  readonly keyId: string;
  /** base64 SPKI DER of the P-256 public key. This is the trust anchor. */
  readonly publicKey: string;
  /** The opaque signed text. Parsed only after the signature verifies. */
  readonly payload: string;
  /** base64 of the raw 64-byte r||s signature. */
  readonly signature: string;
}

export type ParseEnvelopeResult =
  { ok: true; envelope: SignatureEnvelope } | { ok: false; reason: string };

export type VerifyResult =
  | {
      ok: true;
      payload: IntegrityPayload;
      /**
       * The complete public key the signature was verified against. A caller
       * decides trust by comparing *this* to its trust store — not `keyId`.
       */
      publicKeySpki: Uint8Array;
      keyId: string;
    }
  | { ok: false; reason: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unknown fields are rejected everywhere in this format.
 *
 * The permissive instinct is wrong for a document whose job is to constrain:
 * a field this reader drops is a field a future reader enforces, and the gap
 * between them is a package one version accepts and another rejects for
 * reasons neither states.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): string | undefined {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  return unknown.length > 0
    ? `${where} has unknown field(s): ${unknown.sort().join(', ')}`
    : undefined;
}

function isBase64(value: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0 && value.length > 0;
}

/**
 * Rejects any path that could escape the package root or name one file two
 * ways.
 *
 * Escape is the obvious half: a digest entry for `../../etc/passwd` invites a
 * consumer to read outside the package. The subtler half is that `./a.html`
 * and `a.html` are one file under two names, so allowing both would let a
 * package carry two digests for it and satisfy a verifier that happened to
 * look up the benign spelling. Exactly one spelling is legal.
 */
function validateFilePath(path: string): string | undefined {
  if (path === '') return 'empty path';
  if (path.includes('\\')) return 'backslash in path (paths are POSIX-style on every platform)';
  if (path.startsWith('/')) return 'absolute path';
  if (/^[A-Za-z]:/.test(path)) return 'drive-letter path';
  const segments = path.split('/');
  if (segments.some((segment) => segment === '')) return 'empty path segment';
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'relative path segment ("." or "..")';
  }
  return undefined;
}

/**
 * Structural validation of the envelope. No cryptography, and the payload is
 * left as an opaque string — deliberately, so that nothing downstream can be
 * tempted to read the payload before the signature over it has been checked.
 */
export function parseSignatureEnvelope(raw: string): ParseEnvelopeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid JSON: ${detail}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: `${SIGNATURE_FILENAME} must be a JSON object` };
  }
  const unknown = rejectUnknownKeys(
    parsed,
    ['sigVersion', 'algorithm', 'keyId', 'publicKey', 'payload', 'signature'],
    SIGNATURE_FILENAME,
  );
  if (unknown) return { ok: false, reason: unknown };

  // An unrecognized version is refused, not best-effort parsed. For a format
  // that exists to constrain, "I did not understand part of this, so I
  // ignored it" is exactly what an attacker wants.
  if (parsed.sigVersion !== SIGNATURE_ENVELOPE_VERSION) {
    return {
      ok: false,
      reason: `unsupported sigVersion (expected ${SIGNATURE_ENVELOPE_VERSION}, got ${JSON.stringify(parsed.sigVersion)})`,
    };
  }
  if (parsed.algorithm !== INTEGRITY_ALGORITHM) {
    return { ok: false, reason: `algorithm must be "${INTEGRITY_ALGORITHM}"` };
  }
  if (typeof parsed.keyId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(parsed.keyId)) {
    return { ok: false, reason: 'keyId must be a non-empty base64url string' };
  }
  if (typeof parsed.publicKey !== 'string' || !isBase64(parsed.publicKey)) {
    return { ok: false, reason: 'publicKey must be base64-encoded SPKI' };
  }
  if (typeof parsed.payload !== 'string' || parsed.payload === '') {
    return { ok: false, reason: 'payload must be a non-empty string' };
  }
  if (typeof parsed.signature !== 'string' || !isBase64(parsed.signature)) {
    return { ok: false, reason: 'signature must be base64' };
  }

  return {
    ok: true,
    envelope: {
      sigVersion: SIGNATURE_ENVELOPE_VERSION,
      algorithm: INTEGRITY_ALGORITHM,
      keyId: parsed.keyId,
      publicKey: parsed.publicKey,
      payload: parsed.payload,
      signature: parsed.signature,
    },
  };
}

/**
 * Validates an already-verified payload.
 *
 * Only ever called on text whose signature has checked out, so a failure
 * here means the signer produced something malformed — not that a package
 * was tampered with. The distinction matters for the error a user sees.
 */
function parseIntegrityPayload(
  raw: string,
): { ok: true; payload: IntegrityPayload } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `signed payload is not valid JSON: ${detail}` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'signed payload must be a JSON object' };
  }
  const unknown = rejectUnknownKeys(
    parsed,
    ['payloadVersion', 'id', 'version', 'files'],
    'signed payload',
  );
  if (unknown) return { ok: false, reason: unknown };

  if (parsed.payloadVersion !== INTEGRITY_PAYLOAD_VERSION) {
    return {
      ok: false,
      reason: `unsupported payloadVersion (expected ${INTEGRITY_PAYLOAD_VERSION}, got ${JSON.stringify(parsed.payloadVersion)})`,
    };
  }
  if (typeof parsed.id !== 'string' || parsed.id === '') {
    return { ok: false, reason: 'signed payload id must be a non-empty string' };
  }
  if (typeof parsed.version !== 'string' || parsed.version === '') {
    return { ok: false, reason: 'signed payload version must be a non-empty string' };
  }
  if (!isPlainObject(parsed.files)) {
    return { ok: false, reason: 'signed payload files must be an object' };
  }

  const entries = Object.entries(parsed.files);
  // An empty map would let a signature vouch for nothing while still
  // satisfying any check phrased as "every listed file matches".
  if (entries.length === 0) {
    return { ok: false, reason: 'signed payload files must list at least one file' };
  }

  const files: Record<string, string> = {};
  for (const [path, digest] of entries) {
    // The signature file cannot be among the files it attests to: its own
    // bytes include the signature, so a digest of it could never be computed
    // before it existed. A payload that claims otherwise was not produced by
    // any honest signer, and silently ignoring the entry would leave a
    // verifier looking up a file whose digest is unsatisfiable.
    if (path === SIGNATURE_FILENAME) {
      return {
        ok: false,
        reason: `signed payload must not list ${SIGNATURE_FILENAME} among its files`,
      };
    }
    const problem = validateFilePath(path);
    if (problem) {
      return {
        ok: false,
        reason: `signed payload has an invalid path ${JSON.stringify(path)}: ${problem}`,
      };
    }
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      return {
        ok: false,
        reason: `signed payload files[${JSON.stringify(path)}] must be a "sha256-<base64>" digest`,
      };
    }
    files[path] = digest;
  }

  return {
    ok: true,
    payload: {
      payloadVersion: INTEGRITY_PAYLOAD_VERSION,
      id: parsed.id,
      version: parsed.version,
      files,
    },
  };
}

function requireSubtle(): SubtleCrypto {
  const subtle = (globalThis as { crypto?: Crypto }).crypto?.subtle;
  if (!subtle) {
    throw new Error(
      'WebCrypto (crypto.subtle) is unavailable. It requires a secure context: ' +
        'serve the host over HTTPS or from localhost.',
    );
  }
  return subtle;
}

/**
 * Derives the short identifier for a public key: base64url of the SHA-256 of
 * its SPKI bytes.
 *
 * Derived rather than chosen so two people naming the same key agree, and so
 * a mismatch between an envelope's `keyId` and its `publicKey` is detectable
 * as malformedness. It remains an identifier: nothing trusts it.
 */
export async function computeKeyId(publicKeySpki: Uint8Array): Promise<string> {
  return base64UrlEncode(await sha256(publicKeySpki));
}

/** Imports base64 SPKI as a P-256 verifying key. */
export async function importVerifyingKey(publicKeySpki: Uint8Array): Promise<CryptoKey> {
  // The parameter type is derived from `importKey` rather than named as
  // `BufferSource`: that is a type-only global, so naming it trips the lint
  // config's `no-undef`. Same workaround as `sha256` in crypto.ts.
  const data = publicKeySpki as unknown as Parameters<SubtleCrypto['importKey']>[1];
  return requireSubtle().importKey('spki', data, WEBCRYPTO_KEY_PARAMS, true, ['verify']);
}

/**
 * Verifies a parsed envelope and, only if the signature holds, parses and
 * returns the payload it covers.
 *
 * This answers exactly one question — "was this payload signed by the key in
 * this envelope?" — and deliberately not "should that key be trusted?". The
 * second is the caller's, decided against `publicKeySpki` and a trust store
 * the caller owns. Merging them here would produce a verifier that looks
 * authoritative while knowing nothing about who the host actually trusts.
 */
export async function verifySignatureEnvelope(envelope: SignatureEnvelope): Promise<VerifyResult> {
  let publicKeySpki: Uint8Array;
  let signature: Uint8Array;
  try {
    publicKeySpki = base64ToBytes(envelope.publicKey);
    signature = base64ToBytes(envelope.signature);
  } catch {
    return { ok: false, reason: 'envelope contains malformed base64' };
  }

  // WebCrypto's ECDSA expects the raw r||s pair, not the DER-wrapped form
  // that OpenSSL and most command-line tooling emit. Checking the length
  // here turns that very common interop mistake into a stated error instead
  // of an opaque "signature did not verify".
  if (signature.byteLength !== SIGNATURE_BYTE_LENGTH) {
    return {
      ok: false,
      reason: `signature must be ${SIGNATURE_BYTE_LENGTH} raw bytes (r||s), got ${signature.byteLength}; DER-encoded signatures are not accepted`,
    };
  }

  let key: CryptoKey;
  try {
    key = await importVerifyingKey(publicKeySpki);
  } catch {
    return { ok: false, reason: 'publicKey is not a valid P-256 SPKI key' };
  }

  // An envelope whose keyId does not name its own publicKey is malformed.
  // This is not a trust check — trust is decided on the key material by the
  // caller — it just stops a misleading identifier reaching logs and errors.
  const keyId = await computeKeyId(publicKeySpki);
  if (keyId !== envelope.keyId) {
    return { ok: false, reason: 'keyId does not match publicKey' };
  }

  const signed = new TextEncoder().encode(envelope.payload);
  let valid: boolean;
  try {
    valid = await requireSubtle().verify(
      WEBCRYPTO_SIGN_PARAMS,
      key,
      signature as unknown as Parameters<SubtleCrypto['verify']>[2],
      signed as unknown as Parameters<SubtleCrypto['verify']>[3],
    );
  } catch {
    return { ok: false, reason: 'signature verification failed' };
  }
  if (!valid) {
    return { ok: false, reason: 'signature does not match the payload' };
  }

  // Parsed only now. Before this line the payload is untrusted text.
  const payloadResult = parseIntegrityPayload(envelope.payload);
  if (!payloadResult.ok) {
    return { ok: false, reason: payloadResult.reason };
  }

  return { ok: true, payload: payloadResult.payload, publicKeySpki, keyId };
}

/** Convenience: parse and verify in one step. */
export async function verifySignatureFile(raw: string): Promise<VerifyResult> {
  const parsed = parseSignatureEnvelope(raw);
  return parsed.ok ? verifySignatureEnvelope(parsed.envelope) : parsed;
}

/**
 * Serializes an integrity payload to the exact text that will be signed.
 *
 * File paths are emitted in sorted order. Nothing about verification depends
 * on that — the payload is opaque to the signature, so any serialization
 * would verify — but a signer that emitted a different string for the same
 * package on every run would make signed artifacts gratuitously unstable and
 * their diffs unreadable.
 */
export function serializeIntegrityPayload(payload: IntegrityPayload): string {
  const files = Object.fromEntries(
    Object.entries(payload.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
  return JSON.stringify({
    payloadVersion: payload.payloadVersion,
    id: payload.id,
    version: payload.version,
    files,
  });
}

/** Renders an envelope for writing to disk: indented, newline-terminated. */
export function serializeSignatureEnvelope(envelope: SignatureEnvelope): string {
  return `${JSON.stringify(
    {
      sigVersion: envelope.sigVersion,
      algorithm: envelope.algorithm,
      keyId: envelope.keyId,
      publicKey: envelope.publicKey,
      payload: envelope.payload,
      signature: envelope.signature,
    },
    null,
    2,
  )}\n`;
}

export interface SigningKeyPair {
  privateKey: CryptoKey;
  publicKeySpki: Uint8Array;
  keyId: string;
}

/**
 * Generates a P-256 signing key.
 *
 * The private key is extractable so the CLI can write it to a key file; a
 * signing key that cannot be saved would have to be regenerated per run,
 * which defeats the point of a stable identity.
 */
export async function generateSigningKeyPair(): Promise<SigningKeyPair> {
  const pair = await requireSubtle().generateKey(WEBCRYPTO_KEY_PARAMS, true, ['sign', 'verify']);
  const spki = new Uint8Array(await requireSubtle().exportKey('spki', pair.publicKey));
  return { privateKey: pair.privateKey, publicKeySpki: spki, keyId: await computeKeyId(spki) };
}

/**
 * Signs a payload, producing the envelope written to `openmini.sig.json`.
 *
 * The counterpart of `verifySignatureEnvelope`, kept in the same module for
 * the reason this package exists: a producer and a consumer that drift apart
 * is the failure the whole integrity story is trying to avoid, and two
 * implementations in two packages is how they drift.
 *
 * ECDSA is randomized, so signing the same payload twice yields different
 * envelopes. That is expected and is why `build` stays unsigned: build
 * determinism is a property of the package, and signing is a separate step.
 */
export async function signIntegrityPayload(
  payload: IntegrityPayload,
  privateKey: CryptoKey,
  publicKeySpki: Uint8Array,
): Promise<SignatureEnvelope> {
  const payloadText = serializeIntegrityPayload(payload);
  const signed = new TextEncoder().encode(payloadText);
  const signature = new Uint8Array(
    await requireSubtle().sign(
      WEBCRYPTO_SIGN_PARAMS,
      privateKey,
      signed as unknown as Parameters<SubtleCrypto['sign']>[2],
    ),
  );
  return {
    sigVersion: SIGNATURE_ENVELOPE_VERSION,
    algorithm: INTEGRITY_ALGORITHM,
    keyId: await computeKeyId(publicKeySpki),
    publicKey: bytesToBase64(publicKeySpki),
    payload: payloadText,
    signature: bytesToBase64(signature),
  };
}
