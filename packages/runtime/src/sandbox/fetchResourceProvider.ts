import { resolveContainedPath } from './containment';
import type { MiniAppResourceProvider } from './types';

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Normalizes a caller-supplied Mini App package base URL into a single
 * canonical "package root" `URL`, so `createFetchResourceProvider` and
 * `loadMiniAppFromUrl` always resolve paths the same way regardless of how
 * the base URL was typed:
 *
 * - A malformed URL, or one using any scheme other than `http:`/`https:`,
 *   throws a short, non-leaking `Error` before any network access.
 * - `search`/`hash` are stripped unconditionally so they can never influence
 *   package-root resolution.
 * - `pathname` is forced to end with `/` — WHATWG `URL` resolution treats a
 *   base without a trailing slash as a *file* (siblings resolve against its
 *   parent directory), so ".../hello-remote" and ".../hello-remote/" would
 *   otherwise resolve relative paths differently. Forcing the slash makes
 *   both forms resolve inside the same package directory.
 */
export function normalizePackageBaseUrl(rawBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawBaseUrl);
  } catch {
    throw new Error('invalid base URL');
  }

  if (!SUPPORTED_PROTOCOLS.has(parsed.protocol)) {
    throw new Error('unsupported URL scheme');
  }

  parsed.search = '';
  parsed.hash = '';
  if (!parsed.pathname.endsWith('/')) {
    parsed.pathname = `${parsed.pathname}/`;
  }

  return parsed;
}

/**
 * Post-resolution containment: is the URL that resolution actually produced
 * still inside the package root?
 *
 * `resolveContainedPath` asks a different question — whether the *input
 * string* looks like a contained relative path — and no answer to that
 * question can substitute for this one. WHATWG `URL` resolution turns several
 * inputs that look relative into absolute URLs: a bare `scheme:` prefix that
 * differs from the base's scheme discards the base entirely
 * (`new URL('https:evil.com', 'http://h/p/')` is `https://evil.com/`), and
 * `scheme:/path` keeps the host but discards the base path
 * (`new URL('https:/x', 'https://h/p/')` is `https://h/x`). Worse, the two
 * layers do not even see the same string: the shape check runs on the caller's
 * input, while resolution runs on the rejoined, percent-decoded segments, so a
 * leading `./` or an encoded scheme (`./%68ttps:evil.com`) hides a scheme from
 * the input check entirely. This check is therefore the load-bearing one, and
 * it is the only one here that does not depend on predicting parser behaviour.
 *
 * `baseUrl` is normalized to end in `/`, so a prefix match on the serialized
 * form means "inside this directory": scheme, host, port and path must all
 * agree, and `URL` has already collapsed any `..` segments before we look.
 */
function isUnderPackageBase(resolved: URL, baseUrl: URL): boolean {
  return resolved.href.startsWith(baseUrl.href);
}

/**
 * HTTP-fetch-backed `MiniAppResourceProvider`: reads a Mini App package's
 * files over the network from a fixed base URL (its package root), rather
 * than from an in-memory map like `StaticFixtureResourceProvider`. See
 * docs/security/sandbox.md's "Resource loading" section.
 */
export class FetchResourceProvider implements MiniAppResourceProvider {
  private readonly baseUrl: URL;

  constructor(baseUrl: string) {
    this.baseUrl = normalizePackageBaseUrl(baseUrl);
  }

  async readText(relativePath: string): Promise<string> {
    const containment = resolveContainedPath(relativePath);
    if (!containment.ok) {
      throw new Error(`resource path rejected (${containment.reason}): ${relativePath}`);
    }

    const url = new URL(containment.segments.join('/'), this.baseUrl);
    if (!isUnderPackageBase(url, this.baseUrl)) {
      throw new Error(`resource path resolved outside the package base: ${relativePath}`);
    }

    let response: Response;
    try {
      response = await fetch(url);
    } catch {
      throw new Error(`failed to fetch resource: ${relativePath}`);
    }

    if (!response.ok) {
      throw new Error(`resource fetch failed (${response.status}): ${relativePath}`);
    }

    return response.text();
  }
}

export function createFetchResourceProvider(baseUrl: string): MiniAppResourceProvider {
  return new FetchResourceProvider(baseUrl);
}
