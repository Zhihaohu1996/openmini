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
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;

    const provider = createFetchResourceProvider('http://localhost:5173/miniapps/hello-remote/');
    await expect(provider.readText('missing.html')).rejects.toThrow(
      /resource fetch failed \(404\)/,
    );
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
      expect(
        (fetchMock.mock.calls[0] as unknown as [unknown, { redirect: string }])[1].redirect,
      ).toBe('error');
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

describe('digest enforcement', () => {
  const BASE = 'https://cdn.example.com/apps/demo/';
  const BODY = '<!doctype html><title>hi</title>';
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  /** A streaming response, which is the path a real fetch body takes. */
  function streamingOk(text: string) {
    const bytes = new TextEncoder().encode(text);
    let done = false;
    return vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (done) return { done: true, value: undefined };
            done = true;
            return { done: false, value: bytes };
          },
          cancel: async () => undefined,
        }),
      },
      text: async () => {
        throw new Error('text() must not be used when a streaming body exists');
      },
    });
  }

  const digestOf = async (text: string): Promise<string> => {
    const { sha256Base64 } = await import('@openmini/shared');
    return sha256Base64(new TextEncoder().encode(text));
  };

  it('returns a resource whose bytes match its signed digest', async () => {
    global.fetch = streamingOk(BODY) as unknown as typeof fetch;
    const provider = createFetchResourceProvider(BASE, { 'index.html': await digestOf(BODY) });
    await expect(provider.readText('index.html')).resolves.toBe(BODY);
  });

  it('rejects a resource whose bytes do not match', async () => {
    global.fetch = streamingOk('<!doctype html>evil') as unknown as typeof fetch;
    const provider = createFetchResourceProvider(BASE, { 'index.html': await digestOf(BODY) });
    await expect(provider.readText('index.html')).rejects.toThrow(
      /does not match its signed digest/,
    );
  });

  it('refuses a resource the signature does not cover, without fetching it', async () => {
    // Otherwise an attacker adds a file rather than altering one, and every
    // digest still matches.
    const fetchMock = streamingOk(BODY);
    global.fetch = fetchMock as unknown as typeof fetch;
    const provider = createFetchResourceProvider(BASE, { 'index.html': await digestOf(BODY) });

    await expect(provider.readText('extra.js')).rejects.toThrow(/not covered by the package/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('looks the digest up under the single legal spelling of the path', async () => {
    // `./index.html` and `index.html` are the same file. Looking up the
    // caller's raw string would report the first as uncovered.
    global.fetch = streamingOk(BODY) as unknown as typeof fetch;
    const provider = createFetchResourceProvider(BASE, { 'index.html': await digestOf(BODY) });
    await expect(provider.readText('./index.html')).resolves.toBe(BODY);
  });

  it('checks nothing when no digests are supplied', async () => {
    // An unsigned package has nothing to check against. Whether it may load
    // at all is decided in packageVerification, before this point.
    global.fetch = mockFetchOk(BODY) as unknown as typeof fetch;
    await expect(createFetchResourceProvider(BASE).readText('index.html')).resolves.toBe(BODY);
  });

  // Phase 13 W2. `resolveContainedPath` accepts `constructor` and `__proto__`
  // as ordinary segment names — it has no name rule, deliberately — so these
  // paths reach the digest lookup like any other. The house style here is
  // `trustConfig.test.ts`'s "the packages map cannot reach Object.prototype"
  // and `dispatcher.test.ts`'s inherited-member block.
  describe('the digest table cannot reach Object.prototype', () => {
    /**
     * A digest map with an own `__proto__` entry, built the way the verifier
     * builds it: `Object.create(null)`, then assignment.
     *
     * This helper exists because the fixture cannot be written as a literal.
     * In an object literal a `__proto__:` key — quoted or not — is the
     * prototype-setter form and never becomes an own property, so
     * `{ '__proto__': digest }` is an *empty* map and `JSON.stringify` of it
     * emits `{}`. A test written that way would assert against a fixture that
     * does not contain the case under test. Assigning onto a null-prototype
     * object has no inherited setter to reach, so the own property is created.
     * `integrity.test.ts` writes raw JSON for the same reason.
     */
    function digestMapWithProtoEntry(digest: string): Record<string, string> {
      const map = Object.create(null) as Record<string, string>;
      map['__proto__'] = digest;
      return map;
    }

    it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
      'refuses %j, which the signature does not cover, without fetching it',
      async (name) => {
        // A plain object is what an external caller hands in —
        // `createFetchResourceProvider` is exported and takes its digests from
        // the caller. A bare index lookup answers every one of these names
        // with an inherited value, so `expectedDigest` is not `undefined`, the
        // refusal below it does not fire, and the fetch goes out for a file
        // the signature never mentioned.
        const fetchMock = streamingOk(BODY);
        global.fetch = fetchMock as unknown as typeof fetch;
        const provider = createFetchResourceProvider(BASE, { 'index.html': await digestOf(BODY) });

        // The rejection is captured rather than asserted inline so that the
        // two claims below fail independently. Without the gate the request is
        // already on the wire *and* the error misreports the reason, and an
        // inline `rejects.toThrow` would report only the second — leaving the
        // guarantee that actually matters untested. The guarantee is "refused
        // *before* it is fetched", not "eventually rejected"; the spy is what
        // says so, and `stallingResponse`'s test captures the same way.
        const error = await provider.readText(name).catch((reason: unknown) => reason);

        expect(fetchMock).not.toHaveBeenCalled();
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toMatch(
          /resource is not covered by the package signature/,
        );
      },
    );

    it('serves a file the payload genuinely lists under a prototype name', async () => {
      // The complement, and the reason this is a lookup gate rather than a
      // name blocklist: `__proto__` is a legal POSIX filename and a legal
      // manifest entry, so a signed package may honestly list one. Rejecting
      // the name would make such a package unloadable; `Object.hasOwn` asks
      // the only question that matters — did the payload say this?
      global.fetch = streamingOk(BODY) as unknown as typeof fetch;
      const provider = createFetchResourceProvider(
        BASE,
        digestMapWithProtoEntry(await digestOf(BODY)),
      );

      await expect(provider.readText('__proto__')).resolves.toBe(BODY);
    });

    it('still verifies the digest of a file listed under a prototype name', async () => {
      // `hasOwn` decides whether the entry exists; the value it then reads
      // must be the recorded digest and nothing else. Were the gate passing
      // through something merely truthy, this would resolve instead of
      // rejecting.
      global.fetch = streamingOk('<!doctype html>evil') as unknown as typeof fetch;
      const provider = createFetchResourceProvider(
        BASE,
        digestMapWithProtoEntry(await digestOf(BODY)),
      );

      await expect(provider.readText('__proto__')).rejects.toThrow(
        /does not match its signed digest/,
      );
    });
  });
});
