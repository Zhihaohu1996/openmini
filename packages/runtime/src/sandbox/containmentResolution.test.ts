import { describe, expect, it } from 'vitest';
import { resolveContainedPath, type ContainmentFailureReason } from './containment';
import { normalizePackageBaseUrl } from './fetchResourceProvider';

/**
 * R2 reproduction probe (Phase 8.5).
 *
 * `FetchResourceProvider.readText` passes a caller-supplied relative path
 * through `resolveContainedPath` and then through `new URL(path, baseUrl)`.
 * Both of those layers inspect only the *shape of the input string*; neither
 * looks at the URL that actually comes out. This file tests the composition of
 * the two, which is the only place the real question can be asked: can a path
 * that both layers accept still resolve outside the package base?
 *
 * The answer at Phase 8 is yes, so the `stays under the package base` block
 * below is a fail-before/pass-after regression test.
 */

const HTTPS_BASE = 'https://host.example/pkg/';
const HTTP_BASE = 'http://host.example/pkg/';

type ResolutionOutcome =
  | { kind: 'rejected'; reason: ContainmentFailureReason }
  | { kind: 'resolved'; url: string };

/**
 * Mirrors `FetchResourceProvider.readText`'s path handling exactly — same
 * containment call, same `segments.join('/')`, same `new URL` against the same
 * normalized base — without performing any I/O.
 */
function resolveLikeProvider(input: string, rawBase: string): ResolutionOutcome {
  const containment = resolveContainedPath(input);
  if (!containment.ok) {
    return { kind: 'rejected', reason: containment.reason };
  }

  const base = normalizePackageBaseUrl(rawBase);
  return { kind: 'resolved', url: new URL(containment.segments.join('/'), base).href };
}

/**
 * Inputs whose first segment carries a `scheme:` prefix without `//`, plus the
 * opaque schemes. None of these may ever reach the network as written.
 */
const SCHEME_PREFIXED_INPUTS = [
  'https:evil.com',
  'http:evil.com',
  'https:/evil.com',
  'https:\\\\evil.com',
  'data:text/html,x',
  'javascript:alert(1)',
  'about:blank',
] as const;

const KNOWN_GOOD_INPUTS = ['index.html', 'sub/a.html'] as const;

describe('WHATWG URL resolution against a package base (pinned parser behaviour)', () => {
  // These assertions are about the platform, not about our code: they are the
  // reason a post-resolution containment check cannot be replaced by any amount
  // of input-string inspection. They must hold before and after the R2 fix; if
  // a future runtime changes them, the guard is what keeps us safe, and this
  // block is what tells us the ground moved.
  it.each([
    // A `scheme:` prefix matching the base scheme is treated as a *relative*
    // reference: the scheme is dropped and the path resolves inside the base.
    ['https:evil.com', HTTPS_BASE, 'https://host.example/pkg/evil.com'],
    ['http:evil.com', HTTP_BASE, 'http://host.example/pkg/evil.com'],
    // A `scheme:` prefix that differs from the base scheme is treated as an
    // *absolute* URL, and the base is discarded entirely.
    ['https:evil.com', HTTP_BASE, 'https://evil.com/'],
    ['http:evil.com', HTTPS_BASE, 'http://evil.com/'],
    // `scheme:/x` is a scheme-relative path: it keeps the base host but
    // discards the base *path*, so it escapes the package directory.
    ['https:/evil.com', HTTPS_BASE, 'https://host.example/evil.com'],
    // A backslash run is normalized to `//`, making it a full authority.
    ['https:\\\\evil.com', HTTPS_BASE, 'https://evil.com/'],
    // Opaque schemes resolve to themselves; the base is irrelevant.
    ['data:text/html,x', HTTPS_BASE, 'data:text/html,x'],
    ['javascript:alert(1)', HTTPS_BASE, 'javascript:alert(1)'],
    ['about:blank', HTTPS_BASE, 'about:blank'],
  ])('new URL(%j, %j) === %j', (input, base, expected) => {
    expect(new URL(input, base).href).toBe(expected);
  });
});

describe.each([
  ['same-scheme base', HTTPS_BASE],
  ['cross-scheme base', HTTP_BASE],
])('resolveContainedPath + new URL stays under the package base (%s)', (_label, base) => {
  const baseHref = normalizePackageBaseUrl(base).href;

  it.each(SCHEME_PREFIXED_INPUTS)(
    'never resolves %j to a URL outside the package base',
    (input) => {
      const outcome = resolveLikeProvider(input, base);

      // Either layer may do the rejecting — what matters is that nothing which
      // survives both layers points outside the package root.
      if (outcome.kind === 'resolved') {
        expect(outcome.url.startsWith(baseHref)).toBe(true);
      } else {
        expect(outcome.kind).toBe('rejected');
      }
    },
  );

  it.each(KNOWN_GOOD_INPUTS)('still resolves the ordinary relative path %j', (input) => {
    const outcome = resolveLikeProvider(input, base);
    expect(outcome).toEqual({ kind: 'resolved', url: `${baseHref}${input}` });
  });
});
