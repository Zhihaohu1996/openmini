/**
 * The Mini App sandbox document policy: the iframe sandbox attribute and the
 * CSP builder.
 *
 * This lives in @openmini/shared rather than @openmini/runtime because it is
 * pure string logic with no DOM dependency, and two very different consumers
 * need the *same* policy: the browser runtime that *embeds* it in the sandbox
 * document, and the Node CLI that generates packages which must satisfy it.
 * Neither of them enforces it — the browser does, when it parses the
 * document's `Content-Security-Policy` meta tag (see
 * docs/security/sandbox.md). Duplicating it once
 * already produced a "keep this list in sync by hand" comment in the host's
 * fixture build script; there must be exactly one definition.
 *
 * @openmini/runtime re-exports everything here, so existing
 * `@openmini/runtime` import paths keep working.
 */

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
 * `script-src` is intentionally NOT included here — it is document specific
 * (a sha256 hash of that exact document's inline script) and is supplied by
 * the caller via `buildMiniAppCsp`. `style-src` defaults to `'none'` here and
 * is only widened — to hash sources, never to `unsafe-inline` — when a
 * document actually ships an inline `<style>` block.
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

const FORBIDDEN_CSP_SOURCE_SUBSTRINGS = ['unsafe-inline', 'unsafe-eval', "'self'", 'https:'];
const SHA256_SOURCE_PATTERN = /^sha256-[A-Za-z0-9+/]+=*$/;

function assertHashSource(source: string, directive: string): void {
  if (!SHA256_SOURCE_PATTERN.test(source)) {
    throw new Error(`${directive} must be a single 'sha256-...' hash source, got: ${source}`);
  }
  if (FORBIDDEN_CSP_SOURCE_SUBSTRINGS.some((token) => source.includes(token))) {
    throw new Error(`${directive} source rejected as unsafe: ${source}`);
  }
}

/**
 * Builds the full CSP meta value for a Mini App sandbox document.
 *
 * `scriptSrcHashSource` must be a single `sha256-...` hash source (no
 * wildcard, no `'self'`, no `unsafe-inline`/`unsafe-eval`) — enforced here,
 * not just documented, so a regression can't silently widen the policy.
 *
 * `styleSrcHashSources` is optional and held to the identical standard. When
 * empty, `style-src` stays `'none'`. Note that a hash source permits inline
 * `<style>` *elements* only: `style=` attributes are governed by
 * `style-src-attr` (falling back to `style-src`) and hashes do not apply to
 * attributes, so they stay blocked. Permitting them would require
 * `'unsafe-hashes'`, which this policy will not add.
 */
export function buildMiniAppCsp(
  scriptSrcHashSource: string,
  styleSrcHashSources: readonly string[] = [],
): string {
  assertHashSource(scriptSrcHashSource, 'script-src');
  for (const styleSource of styleSrcHashSources) {
    assertHashSource(styleSource, 'style-src');
  }

  const directives: Record<string, string> = {
    'default-src': MINI_APP_BASE_CSP_DIRECTIVES['default-src'] ?? "'none'",
    'script-src': `'${scriptSrcHashSource}'`,
    ...MINI_APP_BASE_CSP_DIRECTIVES,
  };
  // Re-assert after the spread so a future edit to
  // MINI_APP_BASE_CSP_DIRECTIVES can never accidentally overwrite these.
  directives['script-src'] = `'${scriptSrcHashSource}'`;
  if (styleSrcHashSources.length > 0) {
    directives['style-src'] = styleSrcHashSources.map((source) => `'${source}'`).join(' ');
  }

  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}
