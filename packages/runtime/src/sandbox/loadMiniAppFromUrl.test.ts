import { afterEach, describe, expect, it, vi } from 'vitest';
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
    expect(fetchedUrl(fetchMock, 0)).toBe('http://localhost:5173/miniapps/hello-remote/openmini.json');

    fetchMock.mockClear();
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: () => Promise.resolve('<h1>hi</h1>') });
    await result.provider.readText('index.html');
    expect(fetchedUrl(fetchMock, 0)).toBe('http://localhost:5173/miniapps/hello-remote/index.html');
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
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') }) as unknown as typeof fetch;

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
});
