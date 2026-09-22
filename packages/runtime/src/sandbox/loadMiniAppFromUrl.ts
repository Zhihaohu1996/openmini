import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import { SIGNATURE_FILENAME } from '@openmini/shared';
import { BoundedFetchError, fetchBounded } from '../http/boundedFetch';
import { verifyPackage } from './packageVerification';
import type { PackageTrustStore } from './packageVerification';
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

export interface LoadMiniAppOptions {
  /**
   * Which keys may sign which package ids. Omitted means the host registers
   * no ids, so nothing can fail closed and every package loads unverified —
   * which is the pre-Phase-9 behaviour, preserved for callers that have not
   * configured trust yet.
   */
  trustStore?: PackageTrustStore;
}

/**
 * Fetches a Mini App package from `baseUrl` (its package root), verifies it
 * against its detached signature and the host's trust store, and pairs the
 * manifest with a `FetchResourceProvider` that enforces the signed digests
 * on every subsequent read.
 *
 * `ok: false` now covers two quite different things: the package could not
 * be fetched, or it was fetched and refused. Both stop the load, and the
 * reason string distinguishes them.
 *
 * The manifest *is* parsed here, which it deliberately was not before. The
 * id is now load-bearing — it is the key the trust store is consulted with —
 * so a package whose id cannot be determined cannot be checked against
 * policy, and waving it through to be rejected a moment later by
 * `gateManifest` would mean running the trust lookup against a value that
 * does not exist. No working case is lost: `gateManifest` uses this same
 * parser, so anything rejected here would have been rejected there.
 */
export async function loadMiniAppFromUrl(
  baseUrl: string,
  options: LoadMiniAppOptions = {},
): Promise<LoadMiniAppResult> {
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
      {
        timeoutMs: PACKAGE_FETCH_TIMEOUT_MS,
        maxBodyBytes: PACKAGE_MAX_RESOURCE_BYTES,
        // The manifest's own digest is part of what the signature covers,
        // and it must be computed over the bytes that were served. Decoding
        // to text and re-encoding would hash something the server never
        // sent, because invalid UTF-8 does not survive the round trip.
        captureBytes: true,
      },
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
  const manifestBytes = result.bytes;
  if (manifestBytes === undefined) {
    // `captureBytes` was set above, so this cannot happen; stated as a
    // guard rather than asserted, because the alternative to having the
    // bytes is verifying a digest over something else.
    return { ok: false, reason: 'could not capture manifest bytes to verify' };
  }

  const manifestResult = parseManifest(manifestJson);
  if (!manifestResult.valid) {
    return { ok: false, reason: formatManifestIssues(manifestResult.issues) };
  }

  const signatureText = await fetchSignatureText(normalizedBaseUrl);
  if (signatureText.error !== undefined) {
    return { ok: false, reason: signatureText.error };
  }

  const verification = await verifyPackage({
    baseUrl: normalizedBaseUrl.toString(),
    manifestId: manifestResult.manifest.id,
    manifestVersion: manifestResult.manifest.version,
    manifestBytes,
    signatureText: signatureText.text,
    trustStore: options.trustStore,
  });
  if (!verification.ok) {
    return { ok: false, reason: verification.reason };
  }

  return {
    ok: true,
    manifestJson,
    // Carries the signed digests when there are any, so every resource read
    // is checked against the same signature the manifest was.
    provider: createFetchResourceProvider(normalizedBaseUrl.toString(), verification.digests),
    provenance: verification.provenance,
  };
}

/**
 * Fetches `openmini.sig.json`, distinguishing "the server says there is no
 * signature" from "the server did not answer".
 *
 * A non-2xx status is a definite answer — no such file, or you may not have
 * it — and is treated as an unsigned package. A network failure or timeout
 * is no answer at all, and is an error: silently reading it as "unsigned"
 * would let anyone who can disrupt one request decide that a package has no
 * signature.
 *
 * That downgrade is contained either way, because a registered id refuses
 * to load unsigned. The distinction is kept because containment is not a
 * reason to report something inaccurately.
 */
async function fetchSignatureText(
  baseUrl: URL,
): Promise<{ text: string | undefined; error?: string }> {
  const url = new URL(SIGNATURE_FILENAME, baseUrl);
  let result;
  try {
    result = await fetchBounded(
      url.toString(),
      { ...PACKAGE_FETCH_INIT, headers: { Accept: 'application/json' } },
      { timeoutMs: PACKAGE_FETCH_TIMEOUT_MS, maxBodyBytes: PACKAGE_MAX_RESOURCE_BYTES },
    );
  } catch (error) {
    if (error instanceof BoundedFetchError && error.reason === 'timeout') {
      return {
        text: undefined,
        error: `signature fetch timed out after ${PACKAGE_FETCH_TIMEOUT_MS}ms`,
      };
    }
    return { text: undefined, error: 'failed to fetch signature' };
  }

  if (!result.response.ok) {
    return { text: undefined };
  }
  return { text: result.body };
}
