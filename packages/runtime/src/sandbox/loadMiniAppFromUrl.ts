import { BoundedFetchError, fetchBounded } from '../http/boundedFetch';
import {
  createFetchResourceProvider,
  normalizePackageBaseUrl,
  PACKAGE_FETCH_INIT,
  PACKAGE_FETCH_TIMEOUT_MS,
  PACKAGE_MAX_RESOURCE_BYTES,
} from './fetchResourceProvider';
import type { MiniAppResourceProvider, PackageProvenance } from './types';

export type LoadMiniAppResult =
  | {
      ok: true;
      manifestJson: string;
      provider: MiniAppResourceProvider;
      /**
       * Always present on a successful load: a package that came through
       * here has a known origin even when nothing has vouched for its
       * identity. Optionality begins one layer down, at `SandboxOptions`,
       * where a caller may legitimately have no package load at all.
       */
      provenance: PackageProvenance;
    }
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
  //
  // Bounded in size and time and failing closed on redirects, by the same
  // mechanism as the bridge's `network.fetch`. See `../http/boundedFetch`.
  let result;
  try {
    result = await fetchBounded(
      manifestUrl.toString(),
      { ...PACKAGE_FETCH_INIT, headers: { Accept: 'application/json' } },
      { timeoutMs: PACKAGE_FETCH_TIMEOUT_MS, maxBodyBytes: PACKAGE_MAX_RESOURCE_BYTES },
    );
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      switch (error.reason) {
        case 'timeout':
          return {
            ok: false,
            reason: `manifest fetch timed out after ${PACKAGE_FETCH_TIMEOUT_MS}ms`,
          };
        case 'too-large':
          return {
            ok: false,
            reason: `manifest exceeds the ${PACKAGE_MAX_RESOURCE_BYTES}-byte limit`,
          };
      }
    }
    // Includes a refused redirect, which is indistinguishable from any other
    // browser network error.
    return { ok: false, reason: 'failed to fetch manifest' };
  }

  if (!result.response.ok) {
    return { ok: false, reason: `manifest fetch failed (${result.response.status})` };
  }

  const manifestJson = result.body;
  return {
    ok: true,
    manifestJson,
    provider: createFetchResourceProvider(normalizedBaseUrl.toString()),
    provenance: {
      baseUrl: normalizedBaseUrl.toString(),
      // `unsigned` is the literal truth rather than a stand-in: no signature
      // format exists yet, so no package can carry one. When one does, this
      // is where the distinction between `unsigned` and `untrusted-key`
      // starts being made. It stays `verified: false` either way until a
      // signature is actually checked — a loader that reported anything
      // better than it had verified would be the failure this type exists
      // to prevent.
      identity: { verified: false, reason: 'unsigned' },
    },
  };
}
