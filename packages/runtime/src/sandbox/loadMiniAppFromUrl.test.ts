import { afterEach, describe, expect, it, vi } from 'vitest';
import { oversizedStreamingResponse, stallingResponse } from '../http/fakeResponses';
import { PACKAGE_FETCH_TIMEOUT_MS } from './fetchResourceProvider';
import { loadMiniAppFromUrl } from './loadMiniAppFromUrl';

const MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.hello-remote',
  name: 'Hello Remote',
  version: '0.1.0',
  entry: 'index.html',
  permissions: [],
});

function mockFetchOk(text: string) {
  return vi.fn().mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve(text) });
}

function fetchedUrl(fetchMock: ReturnType<typeof vi.fn>, callIndex: number): string {
  const calls = fetchMock.mock.calls as unknown as URL[][];
  const url = calls[callIndex]?.[0];
  if (!url) {
    throw new Error(`fetch was not called at index ${callIndex}`);
  }
  return url.toString();
}

describe('loadMiniAppFromUrl', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches openmini.json and returns a matching resource provider', async () => {
    const fetchMock = mockFetchOk(MANIFEST_JSON);
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.manifestJson).toBe(MANIFEST_JSON);
    expect(fetchedUrl(fetchMock, 0)).toBe(
      'http://localhost:5173/miniapps/hello-remote/openmini.json',
    );

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve('<h1>hi</h1>'),
    });
    await result.provider.readText('index.html');
    expect(fetchedUrl(fetchMock, 0)).toBe('http://localhost:5173/miniapps/hello-remote/index.html');
  });

  it('reports the normalized base URL as provenance, not the string that was passed in', async () => {
    // The caller's URL has no trailing slash; the provider resolves resources
    // against the normalized form. Provenance must record the same normalized
    // value, or a later origin comparison would be made against a URL that
    // resolves differently from the one actually fetched from.
    global.fetch = mockFetchOk(MANIFEST_JSON) as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.baseUrl).toBe('http://localhost:5173/miniapps/hello-remote/');
  });

  it('reports an unverified identity, because nothing verifies one yet', async () => {
    // Fail-honest rather than fail-closed at this layer: the loader's job is
    // to report what it established, and it established no identity. The
    // reason is `unsigned` and not `untrusted-key` because no signature
    // format exists for a package to carry.
    global.fetch = mockFetchOk(MANIFEST_JSON) as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.provenance.identity).toEqual({ verified: false, reason: 'unsigned' });
  });

  it('requests the manifest with an explicit Accept: application/json header', async () => {
    // Without this header, SPA-fallback middleware (Vite dev server, many
    // static hosts) answers an unmatched path with index.html + 200 instead
    // of a real 404, so loadMiniAppFromUrl would silently "succeed" with the
    // wrong content.
    const fetchMock = mockFetchOk(MANIFEST_JSON);
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');

    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(new Headers(init?.headers).get('Accept')).toBe('application/json');
  });

  it('fetches the same manifest URL regardless of trailing slash on the base URL', async () => {
    const fetchMock = mockFetchOk(MANIFEST_JSON);
    global.fetch = fetchMock as unknown as typeof fetch;

    await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');
    await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote/');

    expect(fetchedUrl(fetchMock, 0)).toBe(fetchedUrl(fetchMock, 1));
  });

  it('returns ok:false for a 404 without throwing', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/missing');
    expect(result).toEqual({ ok: false, reason: 'manifest fetch failed (404)' });
  });

  it('returns ok:false for a network error without throwing', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');
    expect(result).toEqual({ ok: false, reason: 'failed to fetch manifest' });
  });

  it('returns ok:false for a malformed base URL without calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('not a url');
    expect(result).toEqual({ ok: false, reason: 'invalid base URL' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns ok:false for an unsupported scheme without calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await loadMiniAppFromUrl('file:///etc/passwd');
    expect(result).toEqual({ ok: false, reason: 'unsupported URL scheme' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A1/W9 (Phase 8.5). The bridge's `network.fetch` has always failed closed
  // on redirects, capped bodies and timed out. The package-load path — same
  // host, same `fetch` — did none of the three, so a package could be loaded
  // from somewhere other than the URL that named it, over an unbounded
  // request that need never finish.
  describe('the package-load fetch is bounded and fails closed', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends redirect: "error", and reports a refused redirect as a failure', async () => {
      // Modelled on the browser: with redirect:'error' a 3xx never becomes a
      // response, it rejects the fetch. Asserting the flag as well as the
      // outcome is what proves we are failing closed rather than just
      // happening not to be redirected.
      const fetchMock = vi.fn((_url: unknown, init: { redirect?: string }) =>
        init.redirect === 'error'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ ok: true, status: 302, text: () => Promise.resolve('elsewhere') }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/hello-remote');

      expect(result).toEqual({ ok: false, reason: 'failed to fetch manifest' });
      expect(
        (fetchMock.mock.calls[0] as unknown as [unknown, { redirect: string }])[1].redirect,
      ).toBe('error');
    });

    it('fails mid-stream on an oversized body, never accumulating the whole of it', async () => {
      const { response, state } = oversizedStreamingResponse();
      global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

      const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/huge');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('exceeds the');
      // 5 MiB cap, 1 MiB chunks: the 6th trips it and the rest is never pulled.
      expect(state.pulled).toBe(6);
      expect(state.cancelled).toBe(true);
    });

    it('does not trust a Content-Length that understates an oversized body', async () => {
      const { response } = oversizedStreamingResponse({ contentLength: '12' });
      global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

      const result = await loadMiniAppFromUrl('http://localhost:5173/miniapps/liar');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('exceeds the');
    });

    it('times out a response that stalls after headers, not merely a slow fetch', async () => {
      vi.useFakeTimers();
      const { response, setSignal } = stallingResponse();
      global.fetch = vi.fn((_url: unknown, init: { signal?: AbortSignal }) => {
        setSignal(init.signal);
        return Promise.resolve(response);
      }) as unknown as typeof fetch;

      const settled = loadMiniAppFromUrl('http://localhost:5173/miniapps/slow');
      await vi.advanceTimersByTimeAsync(PACKAGE_FETCH_TIMEOUT_MS);

      const result = await settled;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toContain('timed out');
    });
  });
});
