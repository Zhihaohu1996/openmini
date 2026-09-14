/**
 * The entire sandbox flag policy for a Mini App iframe: `allow-scripts` and
 * nothing else. `allow-same-origin` in particular must never be added
 * alongside this — since Mini App content is delivered via `srcdoc`
 * (same-origin-adjacent to the host by default), adding it would hand the
 * Mini App a real, non-opaque origin with full host DOM/storage/cookie
 * access. See docs/security/sandbox.md.
 */
export const MINI_APP_SANDBOX_ATTRIBUTE = 'allow-scripts' as const;

/**
 * Deny-by-default CSP directives shared by every Mini App sandbox document.
 * `script-src` is intentionally NOT included here — it is fixture/document
 * specific (a sha256 hash of that exact document's inline bootstrap script
 * in Phase 3) and is supplied by the caller via `buildMiniAppCsp`.
 *
 * No `'self'` anywhere: for `srcdoc` content, relative URLs resolve against
 * the *embedding* document's base URL, and the frame's actual origin is
 * opaque (no `allow-same-origin`), so `'self'` cannot reliably or usefully
 * match anything and risks accidentally leaving a path for Mini App markup
 * to resolve Host-origin resources via relative URLs. Every directive here
 * is therefore an explicit narrow allowance or `'none'`.
 */
export const MINI_APP_BASE_CSP_DIRECTIVES: Readonly<Record<string, string>> = Object.freeze({
  'default-src': "'none'",
  'style-src': "'none'",
  'img-src': "'none'",
  'font-src': "'none'",
  'connect-src': "'none'",
  'frame-src': "'none'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'worker-src': "'none'",
  'script-src-attr': "'none'",
});

const FORBIDDEN_SCRIPT_SRC_SUBSTRINGS = ["unsafe-inline", "unsafe-eval", "'self'", 'https:'];
const SHA256_SOURCE_PATTERN = /^sha256-[A-Za-z0-9+/]+=*$/;

/**
 * Builds the full CSP header/meta value for a Mini App sandbox document.
 * `scriptSrcHashSource` must be a single `sha256-...` hash source (no
 * wildcard, no `'self'`, no `unsafe-inline`/`unsafe-eval`) — this is
 * enforced at build time, not just documented, so a regression can't
 * silently widen the policy.
 */
export function buildMiniAppCsp(scriptSrcHashSource: string): string {
  if (!SHA256_SOURCE_PATTERN.test(scriptSrcHashSource)) {
    throw new Error(
      `script-src must be a single 'sha256-...' hash source, got: ${scriptSrcHashSource}`,
    );
  }
  if (FORBIDDEN_SCRIPT_SRC_SUBSTRINGS.some((token) => scriptSrcHashSource.includes(token))) {
    throw new Error(`script-src source rejected as unsafe: ${scriptSrcHashSource}`);
  }

  const directives: Record<string, string> = {
    'default-src': MINI_APP_BASE_CSP_DIRECTIVES['default-src'] ?? "'none'",
    'script-src': `'${scriptSrcHashSource}'`,
    ...MINI_APP_BASE_CSP_DIRECTIVES,
  };
  // Re-assert script-src after the spread so a future edit to
  // MINI_APP_BASE_CSP_DIRECTIVES can never accidentally overwrite it.
  directives['script-src'] = `'${scriptSrcHashSource}'`;

  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}
