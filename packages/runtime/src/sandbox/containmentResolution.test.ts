import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveContainedPath } from './containment';
import { createFetchResourceProvider, normalizePackageBaseUrl } from './fetchResourceProvider';

/**
 * R2 (Phase 8.5): a resolved package resource must never escape its package
 * base URL.
 *
 * Reading a resource passes a caller-supplied relative path through
 * `resolveContainedPath`, which inspects the *shape of the input string*, and
 * then through `new URL(path, baseUrl)`, which can turn a string that looks
 * relative into an absolute URL. Neither layer looks at the URL that comes
 * out. This file covers the composition, which is the only level at which the
 * question that matters can be asked.
 *
 * The probe that motivated this file reproduced the escape at ec543be, so the
 * end-to-end block is a fail-before/pass-after regression test. It is written
 * against the real `FetchResourceProvider` rather than a re-implementation of
 * its logic, because a model of the pipeline cannot prove the pipeline is safe.
 */

const HTTPS_BASE = 'https://host.example/pkg/';
const HTTP_BASE = 'http://host.example/pkg/';

/**
 * Inputs whose first segment carries a `scheme:` prefix without `//`, and the
 * opaque schemes. The raw-string forms are rejected outright by the shape
 * check; the `./`-prefixed forms are not, and are the reason the
 * post-resolution guard cannot be replaced by a stricter input check — the
 * shape check sees the caller's raw string (which begins with `.`, so no
 * scheme is visible), while `new URL` is handed the rejoined, percent-decoded
 * segments, by which point the leading `./` is gone and `%68` has become `h`.
 * The two layers genuinely do not see the same string.
 *
 * Note that not every row is an escape at every base: a scheme *matching* the
 * base's scheme is treated as a relative reference and stays inside the
 * package. Which rows escape therefore depends on the base, which is exactly
 * why the assertion below is about the resolved URL rather than about which
 * inputs get rejected.
 */
const SCHEME_PREFIXED_INPUTS = [
  'https:evil.com',
  'http:evil.com',
  'https:/evil.com',
  'https:\\\\evil.com',
  'data:text/html,x',
  'javascript:alert(1)',
  'about:blank',
  './https:evil.com',
  './http:evil.com',
  '.\\https:evil.com',
  './%68ttps:evil.com',
  './data:text/html,x',
  './javascript:alert(1)',
] as const;

const KNOWN_GOOD_INPUTS = ['index.html', 'sub/a.html', './index.html', 'a/./b.html'] as const;

describe('WHATWG URL resolution against a package base (pinned parser behaviour)', () => {
  // These assertions are about the platform, not our code: they are the reason
  // a post-resolution containment check cannot be replaced by any amount of
  // input-string inspection. They hold before and after the R2 fix; if a
  // future runtime changes them, the guard is what keeps us safe and this
  // block is what tells us the ground moved.
  it.each([
    // A `scheme:` prefix matching the base scheme is treated as a *relative*
    // reference: the scheme is dropped and the path resolves inside the base.
    ['https:evil.com', HTTPS_BASE, 'https://host.example/pkg/evil.com'],
    ['http:evil.com', HTTP_BASE, 'http://host.example/pkg/evil.com'],
    // A `scheme:` prefix differing from the base scheme is an *absolute* URL,
    // and the base is discarded entirely.
    ['https:evil.com', HTTP_BASE, 'https://evil.com/'],
    ['http:evil.com', HTTPS_BASE, 'http://evil.com/'],
    // `scheme:/x` is a scheme-relative path: it keeps the base host but
    // discards the base *path*, so it escapes the package directory.
    ['https:/evil.com', HTTPS_BASE, 'https://host.example/evil.com'],
    // A backslash run normalizes to `//`, making it a full authority.
    ['https:\\\\evil.com', HTTPS_BASE, 'https://evil.com/'],
    // Opaque schemes resolve to themselves; the base is irrelevant.
    ['data:text/html,x', HTTPS_BASE, 'data:text/html,x'],
    ['javascript:alert(1)', HTTPS_BASE, 'javascript:alert(1)'],
    ['about:blank', HTTPS_BASE, 'about:blank'],
  ])('new URL(%j, %j) === %j', (input, base, expected) => {
    expect(new URL(input, base).href).toBe(expected);
  });
});

describe('resolveContainedPath is a shape check, not a containment authority', () => {
  it.each([
    'https:evil.com',
    'http:evil.com',
    'https:/evil.com',
    'https:\\\\evil.com',
    'data:text/html,x',
    'javascript:alert(1)',
    'about:blank',
  ])('rejects the bare scheme prefix in %j', (input) => {
    const result = resolveContainedPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SCHEME_LIKE');
    }
  });

  it.each(['./https:evil.com', '.\\https:evil.com', './%68ttps:evil.com'])(
    'still accepts %j, whose scheme is hidden from it',
    (input) => {
      // Not a bug in this function — it is answering a question about the
      // input string, and the input string does not start with a scheme. It is
      // a demonstration that the answer is not sufficient on its own.
      const result = resolveContainedPath(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.segments.join('/')).toMatch(/^https:/);
      }
    },
  );

  it('rejects a first segment containing a colon (the accepted cost)', () => {
    const result = resolveContainedPath('my:file.html');
    expect(result.ok).toBe(false);
  });
});

describe.each([
  ['same-scheme base', HTTPS_BASE],
  ['cross-scheme base', HTTP_BASE],
])('FetchResourceProvider never reads outside the package base (%s)', (_label, base) => {
  const baseHref = normalizePackageBaseUrl(base).href;
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function installFetch() {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('x') });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it.each(SCHEME_PREFIXED_INPUTS)('requests nothing outside the base for %j', async (input) => {
    const fetchMock = installFetch();
    const provider = createFetchResourceProvider(base);

    // The input may be refused by either layer, or accepted as an ordinary
    // file inside the package — all three are fine. What must never happen is
    // a request to a URL outside the package root, so the assertion is on the
    // requests actually made. Checking after the fact would be too late: for
    // `javascript:`/`data:` the request itself is the vulnerability.
    await provider.readText(input).catch(() => undefined);

    for (const call of fetchMock.mock.calls as unknown as URL[][]) {
      expect(String(call[0]).startsWith(baseHref)).toBe(true);
    }
  });

  it('refuses a cross-scheme resolution outright rather than reading it', async () => {
    const fetchMock = installFetch();
    const crossScheme = base === HTTPS_BASE ? './http:evil.com' : './https:evil.com';

    await expect(createFetchResourceProvider(base).readText(crossScheme)).rejects.toThrow(
      /resolved outside the package base/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a same-scheme prefix as an ordinary file inside the package', async () => {
    const fetchMock = installFetch();
    const sameScheme = base === HTTPS_BASE ? './https:evil.com' : './http:evil.com';

    // Characterization, not an endorsement: the parser drops the redundant
    // scheme, leaving a file named `evil.com` in the package root. Contained,
    // therefore allowed — and worth pinning, because it is the one row in the
    // table whose benign outcome depends on a parser detail.
    await expect(createFetchResourceProvider(base).readText(sameScheme)).resolves.toBe('x');
    expect(String((fetchMock.mock.calls as unknown as URL[][])[0]?.[0])).toBe(
      `${baseHref}evil.com`,
    );
  });

  it.each(KNOWN_GOOD_INPUTS)('still reads the ordinary relative path %j', async (input) => {
    const fetchMock = installFetch();
    const provider = createFetchResourceProvider(base);

    await expect(provider.readText(input)).resolves.toBe('x');
    const requested = String((fetchMock.mock.calls as unknown as URL[][])[0]?.[0]);
    expect(requested.startsWith(baseHref)).toBe(true);
  });
});
