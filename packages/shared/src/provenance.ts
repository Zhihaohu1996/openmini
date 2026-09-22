/**
 * The provenance sidecar: the document that says which bytes a Mini App
 * package is made of, and who vouches for them.
 *
 * This lives in @openmini/shared for the same reason `crypto.ts` and `csp.ts`
 * do: the Node CLI *writes* this document and the browser runtime *reads* it,
 * and the two must agree exactly. Here that agreement is sharper than usual,
 * because a signature binds a specific byte sequence. If the producer and the
 * consumer derive even slightly different bytes from the same document, every
 * honest package fails verification and no dishonest one is caught.
 *
 * This module is deliberately crypto-free beyond the digest *format*. It
 * defines the shape, the canonical signing input, and a strict parser — the
 * plumbing every later step needs. Producing digests and signatures (CLI) and
 * checking them (runtime) are separate concerns built on top.
 *
 * ## Why the signature covers a canonical form, not the file's bytes
 *
 * The obvious design is to sign the sidecar file verbatim. It is also the
 * fragile one: it makes the signature depend on key order, indentation and
 * the trailing newline, so pretty-printing a sidecar — or a Git checkout that
 * rewrites line endings, which this repo has already been bitten by — breaks
 * verification on a package nobody tampered with.
 *
 * Instead, the signature covers `provenanceSigningInput()`: bytes derived
 * from the *parsed* subject by one deterministic rule. The file's own
 * formatting is then irrelevant, and a verifier never has to trust that the
 * bytes it hashed are the bytes it parsed — it re-derives them from the
 * values it is actually going to act on.
 *
 * That property also disposes of duplicate JSON keys. `JSON.parse` silently
 * keeps the last of `{"a":1,"a":2}`, which would be a real hazard for a
 * verifier that hashed the raw text and acted on the parse. Because the
 * signing input is re-derived from the parse, a duplicated key either changes
 * nothing or changes the canonical bytes — and then the signature simply
 * fails. There is no state in which the verifier checks one value and uses
 * another.
 */

/** Sidecar filename, a sibling of `openmini.json` at the package root. */
export const PROVENANCE_FILENAME = 'openmini.provenance.json';

/**
 * The only format version this build understands.
 *
 * An unrecognized version is rejected rather than best-effort parsed. For a
 * format whose entire job is integrity, "I did not understand part of this
 * document, so I ignored it" is precisely the behaviour an attacker wants: a
 * later version may add a field that *restricts* what a package may do, and a
 * forward-compatible reader would silently drop it.
 */
export const PROVENANCE_VERSION = 1;

/**
 * The one signature algorithm the format admits. Ed25519 is small, has no
 * parameter choices to get wrong, and is available in WebCrypto in both
 * Node >= 24 and current browsers — the same isomorphism constraint that
 * shaped `crypto.ts`.
 *
 * Algorithm agility is deliberately absent: a negotiable algorithm field is a
 * downgrade-attack surface, and the version bump above is the intended way to
 * change algorithms. The signing input is domain-separated by version, so a
 * v1 signature cannot be replayed into a v2 document.
 */
export const PROVENANCE_SIGNATURE_ALGORITHM = 'ed25519';

/** Ed25519 signatures are exactly 64 bytes, which is 88 base64 characters. */
const SIGNATURE_BYTE_LENGTH = 64;
const SIGNATURE_PATTERN = /^[A-Za-z0-9+/]{86}==$/;

/** `sha256-` + base64 of 32 bytes, which is always 44 characters with padding. */
const DIGEST_PATTERN = /^sha256-[A-Za-z0-9+/]{43}=$/;

/** base64url, unpadded — the form `base64UrlEncode` in `crypto.ts` produces. */
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * What a signature vouches for: a named package and the exact bytes of every
 * file in it.
 *
 * `id` and `version` are copied from the manifest rather than left implicit.
 * Without them a signature over a file list is transplantable — lift the
 * sidecar from a signed package onto a package claiming a different `id`, and
 * the digests still match because the files are the same. Binding the
 * identity into the signed bytes is what lets a verifier answer "is this
 * package entitled to the id it claims", which is the open question
 * docs/security/bridge.md records against storage.
 */
export interface ProvenanceSubject {
  readonly id: string;
  readonly version: string;
  /**
   * Package-relative POSIX path → `sha256-<base64>` digest of that file's
   * bytes. Every file the loader may read must appear; a path absent from
   * this map is a file the signature says nothing about.
   */
  readonly files: Readonly<Record<string, string>>;
}

export interface ProvenanceSignature {
  readonly algorithm: typeof PROVENANCE_SIGNATURE_ALGORITHM;
  /** Identifies the public key, not a secret. base64url, so it is safe in logs and URLs. */
  readonly keyId: string;
  /** The raw 64-byte Ed25519 signature, standard base64. */
  readonly value: string;
}

export interface ProvenanceDocument {
  readonly provenanceVersion: typeof PROVENANCE_VERSION;
  readonly subject: ProvenanceSubject;
  /**
   * Absent for an unsigned package. An unsigned sidecar still pins content —
   * it detects corruption and in-transit modification — but attests to no
   * author. Callers must not treat "parsed successfully" as "signed"; the two
   * questions are separate and are answered by separate code.
   */
  readonly signature?: ProvenanceSignature;
}

export type ProvenanceParseResult =
  { ok: true; document: ProvenanceDocument } | { ok: false; reason: string };

/**
 * Rejects any path that could escape the package root or that names the same
 * file two ways.
 *
 * Both halves matter. Escape is the obvious one: a digest entry for
 * `../../etc/passwd` invites a consumer to read outside the package. The
 * second is subtler — `./a.html` and `a.html` are the same file under one
 * name each, so permitting both would let a package present two digests for
 * one file and satisfy a verifier that happened to look up the benign
 * spelling. Only one spelling is legal, so the question never arises.
 *
 * Backslashes are rejected rather than translated: the package format is
 * POSIX-path-shaped on every platform, and a Windows-style path in a sidecar
 * means the producer was wrong, not that the consumer should guess.
 */
function validateFilePath(path: string): string | undefined {
  if (path === '') {
    return 'empty path';
  }
  if (path.includes('\\')) {
    return 'backslash in path (paths are POSIX-style on every platform)';
  }
  if (path.startsWith('/')) {
    return 'absolute path';
  }
  if (/^[A-Za-z]:/.test(path)) {
    return 'drive-letter path';
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment === '')) {
    return 'empty path segment';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'relative path segment ("." or "..")';
  }
  return undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unknown keys are an error, everywhere in this document.
 *
 * The permissive instinct — ignore what you do not recognize — is wrong for a
 * format that exists to constrain. A field this reader drops is a field a
 * future reader enforces, and the gap between them is a package that one
 * version accepts and another rejects for reasons neither states.
 */
function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  where: string,
): string | undefined {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    return `${where} has unknown field(s): ${unknown.sort().join(', ')}`;
  }
  return undefined;
}

type SignatureParseResult =
  { ok: true; signature: ProvenanceSignature } | { ok: false; reason: string };

function parseSignature(value: unknown): SignatureParseResult {
  if (!isPlainObject(value)) {
    return { ok: false, reason: 'signature must be an object' };
  }
  const unknown = rejectUnknownKeys(value, ['algorithm', 'keyId', 'value'], 'signature');
  if (unknown) {
    return { ok: false, reason: unknown };
  }
  if (value.algorithm !== PROVENANCE_SIGNATURE_ALGORITHM) {
    return { ok: false, reason: `signature.algorithm must be "${PROVENANCE_SIGNATURE_ALGORITHM}"` };
  }
  if (typeof value.keyId !== 'string' || !KEY_ID_PATTERN.test(value.keyId)) {
    return { ok: false, reason: 'signature.keyId must be a non-empty base64url string' };
  }
  // Length is checked here, at the format boundary, so an obviously wrong
  // signature is a parse error naming the field rather than an opaque
  // "verification failed" much later, where it would be indistinguishable
  // from a genuinely tampered package.
  if (typeof value.value !== 'string' || !SIGNATURE_PATTERN.test(value.value)) {
    return {
      ok: false,
      reason: `signature.value must be base64 of exactly ${SIGNATURE_BYTE_LENGTH} bytes`,
    };
  }
  return {
    ok: true,
    signature: {
      algorithm: PROVENANCE_SIGNATURE_ALGORITHM,
      keyId: value.keyId,
      value: value.value,
    },
  };
}

/**
 * Parses and fully validates a provenance sidecar.
 *
 * Returns a result rather than throwing, matching `parseManifest` in
 * @openmini/manifest: a malformed sidecar is an expected input on the load
 * path, not an exceptional one, and the runtime has to turn it into a
 * user-visible reason string either way.
 */
export function parseProvenance(raw: string): ProvenanceParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: `invalid JSON: ${detail}` };
  }

  if (!isPlainObject(parsed)) {
    return { ok: false, reason: 'provenance must be a JSON object' };
  }
  const unknownTop = rejectUnknownKeys(
    parsed,
    ['provenanceVersion', 'subject', 'signature'],
    'provenance',
  );
  if (unknownTop) {
    return { ok: false, reason: unknownTop };
  }

  if (parsed.provenanceVersion !== PROVENANCE_VERSION) {
    return {
      ok: false,
      reason: `unsupported provenanceVersion (expected ${PROVENANCE_VERSION}, got ${JSON.stringify(
        parsed.provenanceVersion,
      )})`,
    };
  }

  const subject = parsed.subject;
  if (!isPlainObject(subject)) {
    return { ok: false, reason: 'subject must be an object' };
  }
  const unknownSubject = rejectUnknownKeys(subject, ['id', 'version', 'files'], 'subject');
  if (unknownSubject) {
    return { ok: false, reason: unknownSubject };
  }
  if (typeof subject.id !== 'string' || subject.id === '') {
    return { ok: false, reason: 'subject.id must be a non-empty string' };
  }
  if (typeof subject.version !== 'string' || subject.version === '') {
    return { ok: false, reason: 'subject.version must be a non-empty string' };
  }
  if (!isPlainObject(subject.files)) {
    return { ok: false, reason: 'subject.files must be an object' };
  }

  const fileEntries = Object.entries(subject.files);
  // An empty map would let a package carry a technically valid, signable
  // sidecar that vouches for nothing at all, and pass any check written as
  // "every listed file matches".
  if (fileEntries.length === 0) {
    return { ok: false, reason: 'subject.files must list at least one file' };
  }
  const files: Record<string, string> = {};
  for (const [path, digest] of fileEntries) {
    const pathProblem = validateFilePath(path);
    if (pathProblem) {
      return {
        ok: false,
        reason: `subject.files has an invalid path ${JSON.stringify(path)}: ${pathProblem}`,
      };
    }
    if (typeof digest !== 'string' || !DIGEST_PATTERN.test(digest)) {
      return {
        ok: false,
        reason: `subject.files[${JSON.stringify(path)}] must be a "sha256-<base64>" digest`,
      };
    }
    files[path] = digest;
  }

  let signature: ProvenanceSignature | undefined;
  if (parsed.signature !== undefined) {
    const signatureResult = parseSignature(parsed.signature);
    if (!signatureResult.ok) {
      return { ok: false, reason: signatureResult.reason };
    }
    signature = signatureResult.signature;
  }

  return {
    ok: true,
    document: {
      provenanceVersion: PROVENANCE_VERSION,
      subject: { id: subject.id, version: subject.version, files },
      ...(signature ? { signature } : {}),
    },
  };
}

/**
 * The file map in the one order every consumer must see it in: ascending
 * UTF-16 code-unit order of the path.
 *
 * Compared with `<` on the raw strings, not `localeCompare`, because
 * code-unit order is the one string ordering identical in every JavaScript
 * engine without a locale, a collator, or an options bag. A locale-aware sort
 * would order the same keys differently on two machines, which for a signing
 * input means a valid package that fails to verify abroad.
 *
 * Sorting entries, rather than sorting keys and looking each one up, keeps
 * each digest paired with its path by construction. The lookup form also does
 * not typecheck under `noUncheckedIndexedAccess` without an assertion, and an
 * assertion is the wrong tool for reassuring a reader that a map's own keys
 * are present in it.
 */
function sortedFileEntries(files: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The canonical JSON text of a subject: keys in ascending code-unit order, no
 * insignificant whitespace.
 *
 * `JSON.stringify`'s string escaping is fully specified — including lone
 * surrogates, which it emits as escape sequences rather than as replacement
 * characters — so two engines encode the same string identically.
 */
function canonicalizeSubject(subject: ProvenanceSubject): string {
  const files = sortedFileEntries(subject.files)
    .map(([path, digest]) => `${JSON.stringify(path)}:${JSON.stringify(digest)}`)
    .join(',');
  // Top-level keys are written out in sorted order literally, rather than
  // sorted at runtime, so the canonical shape is readable here and a new
  // field cannot be added to the type without someone deciding where it goes.
  return `{"files":{${files}},"id":${JSON.stringify(subject.id)},"version":${JSON.stringify(
    subject.version,
  )}}`;
}

/**
 * Domain-separation prefix. Signing raw canonical JSON would let a signature
 * produced for this format be replayed as a signature over any other format
 * that happens to accept the same bytes — including a future provenance
 * version. Tying the version into the signed bytes means a v1 signature can
 * only ever be a v1 signature.
 */
const SIGNING_INPUT_PREFIX = `openmini-provenance-v${PROVENANCE_VERSION}\n`;

/**
 * The exact bytes a provenance signature covers.
 *
 * Both the signer and the verifier call this, on the subject they parsed, so
 * neither depends on the sidecar file's formatting and neither can sign or
 * verify bytes it did not also interpret.
 */
export function provenanceSigningInput(subject: ProvenanceSubject): Uint8Array {
  return new TextEncoder().encode(SIGNING_INPUT_PREFIX + canonicalizeSubject(subject));
}

/**
 * Renders a sidecar for writing to disk.
 *
 * Indented and newline-terminated because it is a file humans will open and
 * diff, and — unlike the signing input — nothing depends on its exact bytes.
 * The build that emits it is required to be deterministic, so the key order
 * is fixed here rather than left to insertion order.
 */
export function serializeProvenance(document: ProvenanceDocument): string {
  const files = Object.fromEntries(sortedFileEntries(document.subject.files));
  const ordered = {
    provenanceVersion: document.provenanceVersion,
    subject: { id: document.subject.id, version: document.subject.version, files },
    ...(document.signature
      ? {
          signature: {
            algorithm: document.signature.algorithm,
            keyId: document.signature.keyId,
            value: document.signature.value,
          },
        }
      : {}),
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}
