/**
 * Isomorphic digest and base64 primitives.
 *
 * This lives in @openmini/shared for the same reason `csp.ts` does: two very
 * different consumers need byte-for-byte identical results. The Node CLI
 * *produces* a package's integrity digests and the browser runtime *verifies*
 * them, and a digest that disagrees between producer and consumer is worse
 * than no digest at all — it fails closed on honest packages while proving
 * nothing about dishonest ones.
 *
 * Everything here is built on `globalThis.crypto.subtle`, which exists in
 * browsers and in Node (the repo requires Node >= 24, see `.nvmrc`), so there
 * is exactly one implementation rather than a Node branch and a browser
 * branch. That also means no new dependency.
 *
 * Deliberately *not* consolidated here: `packages/cli/src/packageBuild.ts`'s
 * own `sha256Base64`. WebCrypto's digest is async, and `assembleEntryDocument`
 * is synchronous; making it async to share this helper would ripple through
 * the CSP and determinism suites for no benefit, since those hashes never
 * cross the CLI/runtime boundary. See the comment at that call site.
 */

/**
 * `crypto.subtle` is only exposed in a secure context. A host served over
 * plain HTTP on a non-loopback origin therefore has no `subtle` at all, and
 * every digest below throws rather than silently degrading — an integrity
 * check that quietly stops checking is the failure mode this whole module
 * exists to prevent.
 */
function requireSubtle(): SubtleCrypto {
  const globalCrypto = (globalThis as { crypto?: Crypto }).crypto;
  const subtle = globalCrypto?.subtle;
  if (!subtle) {
    throw new Error(
      'WebCrypto (crypto.subtle) is unavailable. It requires a secure context: ' +
        'serve the host over HTTPS or from localhost.',
    );
  }
  return subtle;
}

/** Standard base64 (RFC 4648 §4), the encoding used throughout the sidecar. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Decodes standard base64. Throws on anything `atob` rejects, so a malformed
 * field in a signature envelope surfaces as a parse failure rather than as
 * silently truncated bytes that then fail a digest comparison for the wrong
 * reason.
 */
export function base64ToBytes(value: string): Uint8Array {
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error('invalid base64');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** base64url (RFC 4648 §5), unpadded — used for `keyId`, which appears in JSON and logs. */
export function base64UrlEncode(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Raw SHA-256 digest of exactly the bytes given. */
export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  // `bytes.buffer` may be a view into a larger ArrayBuffer (a chunk of a
  // stream, say), so the view — not the backing buffer — is what gets hashed.
  //
  // The parameter type is derived from `digest` itself rather than named as
  // `BufferSource`: that is a type-only global, so naming it trips the lint
  // config's `no-undef`, which only knows about *runtime* globals. Same
  // workaround, and same reason, as `BoundedFetchInit` in
  // packages/runtime/src/http/boundedFetch.ts.
  const data = bytes as unknown as Parameters<SubtleCrypto['digest']>[1];
  const digest = await requireSubtle().digest('SHA-256', data);
  return new Uint8Array(digest);
}

/**
 * The digest form written into an integrity payload: `sha256-<base64>`.
 *
 * Prefixed with the algorithm rather than bare, so a future algorithm change
 * is a visible mismatch instead of two same-length base64 strings that happen
 * to disagree.
 */
export async function sha256Base64(bytes: Uint8Array): Promise<string> {
  return `sha256-${bytesToBase64(await sha256(bytes))}`;
}

/** Convenience for text inputs; encodes as UTF-8 first. */
export async function sha256Base64Utf8(text: string): Promise<string> {
  return sha256Base64(new TextEncoder().encode(text));
}

/**
 * Compares two digest strings.
 *
 * Digests of a public package are public values, so a timing side channel
 * here leaks nothing an attacker cannot compute themselves — this is not
 * constant-time and does not need to be. It is written as an explicit
 * length-then-content loop anyway, and this comment exists, so that a future
 * reader does not "harden" it into something slower under the mistaken
 * impression that `===` on public digests was a vulnerability.
 */
export function digestsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}
