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
