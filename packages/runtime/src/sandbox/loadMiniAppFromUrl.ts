import { createFetchResourceProvider, normalizePackageBaseUrl } from './fetchResourceProvider';
import type { MiniAppResourceProvider } from './types';

export type LoadMiniAppResult =
  | { ok: true; manifestJson: string; provider: MiniAppResourceProvider }
  | { ok: false; reason: string };

const MANIFEST_FILENAME = 'openmini.json';

/**
 * Fetches a Mini App package's manifest from `baseUrl` (its package root) and
 * pairs it with a `FetchResourceProvider` pointed at the same root, so the
 * caller ends up with exactly the two values `MiniAppHost` already needs
 * (`manifestJson`, `resourceProvider`) — the same shape every static fixture
 * provides today.
 *
 * Deliberately does not parse/validate the manifest itself: `MiniAppHost`
 * already runs every `manifestJson` it's given through `gateManifest`, so a
 * real package's manifest content errors surface through that exact same,
 * already-tested path. `ok: false` here means only that the manifest could
 * not even be fetched (bad base URL, network failure, non-2xx response).
 */
export async function loadMiniAppFromUrl(baseUrl: string): Promise<LoadMiniAppResult> {
  let normalizedBaseUrl: URL;
  try {
    normalizedBaseUrl = normalizePackageBaseUrl(baseUrl);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : 'invalid base URL' };
  }

  const manifestUrl = new URL(MANIFEST_FILENAME, normalizedBaseUrl);

  // An unset Accept header defaults to `*/*`, which SPA-fallback middleware
  // (Vite dev server, many static hosts) treats as a navigation request and
  // answers with `index.html` + 200 instead of a real 404.
  let response: Response;
  try {
    response = await fetch(manifestUrl, { headers: { Accept: 'application/json' } });
  } catch {
    return { ok: false, reason: 'failed to fetch manifest' };
  }

  if (!response.ok) {
    return { ok: false, reason: `manifest fetch failed (${response.status})` };
  }

  const manifestJson = await response.text();
  return {
    ok: true,
    manifestJson,
    provider: createFetchResourceProvider(normalizedBaseUrl.toString()),
  };
}
