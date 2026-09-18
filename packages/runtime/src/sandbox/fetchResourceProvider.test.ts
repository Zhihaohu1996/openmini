import { afterEach, describe, expect, it, vi } from 'vitest';
import { oversizedStreamingResponse, stallingResponse } from '../http/fakeResponses';
import {
  createFetchResourceProvider,
  normalizePackageBaseUrl,
  PACKAGE_FETCH_TIMEOUT_MS,
} from './fetchResourceProvider';

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

describe('normalizePackageBaseUrl', () => {
  it('appends a trailing slash when missing', () => {
    expect(normalizePackageBaseUrl('http://localhost:5173/miniapps/hello-remote').toString()).toBe(
      'http://localhost:5173/miniapps/hello-remote/',
    );
  });

  it('leaves an already-trailing-slash base URL unchanged', () => {
    expect(normalizePackageBaseUrl('http://localhost:5173/miniapps/hello-remote/').toString()).toBe(
      'http://localhost:5173/miniapps/hello-remote/',
    );
  });

  it('strips query and hash so they cannot affect package-root resolution', () => {
    expect(
      normalizePackageBaseUrl('http://localhost:5173/miniapps/hello-remote?x=1#frag').toString(),
    ).toBe('http://localhost:5173/miniapps/hello-remote/');
  });

  it('rejects a malformed URL', () => {
    expect(() => normalizePackageBaseUrl('not a url')).toThrow(/invalid base URL/);
  });

  it('rejects an unsupported scheme', () => {
    expect(() => normalizePackageBaseUrl('file:///etc/passwd')).toThrow(/unsupported URL scheme/);
    expect(() => normalizePackageBaseUrl('data:text/plain,hi')).toThrow(/unsupported URL scheme/);
    expect(() => normalizePackageBaseUrl('javascript:alert(1)')).toThrow(/unsupported URL scheme/);
  });
});

describe('createFetchResourceProvider', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('fetches the relative path resolved against the normalized base URL', async () => {
    const fetchMock = mockFetchOk('<h1>hi</h1>');
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote');
    await expect(provider.readText('index.html')).resolves.toBe('<h1>hi</h1>');
    expect(fetchedUrl(fetchMock, 0)).toBe('http://localhost:5173/miniapps/hello-remote/index.html');
  });

  it('resolves identically whether the base URL has a trailing slash or not', async () => {
    const fetchMock = mockFetchOk('ok');
    global.fetch = fetchMock as unknown as typeof fetch;

    await createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote').readText(
      'index.html',
    );
    await createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote/').readText(
      'index.html',
    );

    const firstUrl = fetchedUrl(fetchMock, 0);
    const secondUrl = fetchedUrl(fetchMock, 1);
    expect(firstUrl).toBe(secondUrl);
    expect(firstUrl).toBe('http://localhost:5173/miniapps/hello-remote/index.html');
  });

  it('rejects a containment-violating relative path before ever calling fetch', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote/');
    await expect(provider.readText('../secret.html')).rejects.toThrow(/resource path rejected/);
    await expect(provider.readText('%2e%2e/secret.html')).rejects.toThrow(/resource path rejected/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a path that resolves outside the base, distinctly from a rejected shape', async () => {
    const fetchMock = vi.fn();
    global.fetch = fetchMock as unknown as typeof fetch;

    const provider = createFetchResourceProvider('https://host.example/pkg/');
    // The leading `./` hides the scheme from the input-shape check, so this
    // reaches the post-resolution guard — and the distinct message proves it
    // is the guard, not `resolveContainedPath`, doing the rejecting.
    await expect(provider.readText('./http:evil.com')).rejects.toThrow(
      /resource path resolved outside the package base/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws on a non-2xx response', async () => {
    global.fetch = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 404, text: () => Promise.resolve('') }) as unknown as typeof fetch;

    const provider = createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote/');
    await expect(provider.readText('missing.html')).rejects.toThrow(/resource fetch failed \(404\)/);
  });

  it('throws when fetch itself rejects with a network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;

    const provider = createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote/');
    await expect(provider.readText('index.html')).rejects.toThrow(/failed to fetch resource/);
  });

  // A1/W9 (Phase 8.5). The same four guarantees the manifest load now has,
  // asserted for a resource read: the two are the same threat over the same
  // transport, so a cap on one and not the other is no cap at all.
  describe('resource reads are bounded and fail closed', () => {
    const BASE = 'http://localhost:5173/miniapps/hello-remote/';

    afterEach(() => {
      vi.useRealTimers();
    });

    it('sends redirect: "error", and reports a refused redirect as a failure', async () => {
      const fetchMock = vi.fn((_url: unknown, init: { redirect?: string }) =>
        init.redirect === 'error'
          ? Promise.reject(new TypeError('Failed to fetch'))
          : Promise.resolve({ ok: true, status: 302, text: () => Promise.resolve('elsewhere') }),
      );
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(createFetchResourceProvider(BASE).readText('index.html')).rejects.toThrow(
        /failed to fetch resource/,
      );
      expect((fetchMock.mock.calls[0] as unknown as [unknown, { redirect: string }])[1].redirect).toBe(
        'error',
      );
    });

    it('fails mid-stream on an oversized resource, never accumulating the whole of it', async () => {
      const { response, state } = oversizedStreamingResponse();
      global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

      await expect(createFetchResourceProvider(BASE).readText('huge.html')).rejects.toThrow(
        /exceeds the .*-byte limit/,
      );
      expect(state.pulled).toBe(6);
      expect(state.cancelled).toBe(true);
    });

    it('does not trust a Content-Length that understates an oversized resource', async () => {
      const { response } = oversizedStreamingResponse({ contentLength: '12' });
      global.fetch = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;

      await expect(createFetchResourceProvider(BASE).readText('liar.html')).rejects.toThrow(
        /exceeds the .*-byte limit/,
      );
    });

    it('times out a resource that stalls after headers', async () => {
      vi.useFakeTimers();
      const { response, setSignal } = stallingResponse();
      global.fetch = vi.fn((_url: unknown, init: { signal?: AbortSignal }) => {
        setSignal(init.signal);
        return Promise.resolve(response);
      }) as unknown as typeof fetch;

      const settled = createFetchResourceProvider(BASE)
        .readText('slow.html')
        .catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(PACKAGE_FETCH_TIMEOUT_MS);

      expect((await settled) as Error).toHaveProperty(
        'message',
        expect.stringContaining('timed out'),
      );
    });
  });
});
