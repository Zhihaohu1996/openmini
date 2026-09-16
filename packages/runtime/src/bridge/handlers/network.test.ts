import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it, vi } from 'vitest';
import { BridgeInvalidParamsError, BridgeNetworkError, BridgePermissionDeniedError } from '../errors';
import type { BridgeHandlerContext, BridgeMethodHandler } from '../types';
import { createNetworkHandlers, isLoopbackHostname } from './network';

const MANIFEST: OpenMiniManifest = {
  schemaVersion: 1,
  id: 'com.openmini.net-demo',
  name: 'Net Demo',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['network'],
  network: { domains: ['api.example.com', 'localhost', '127.0.0.1', '[::1]'] },
};

const CTX = { manifest: MANIFEST } as BridgeHandlerContext;

function okResponse(body = 'hello', init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: init.headers ?? { 'content-type': 'text/plain' },
  });
}

/** The registry is `Record<string, handler>`, so resolve `fetch` once here. */
function networkFetchHandler(options: Parameters<typeof createNetworkHandlers>[0] = {}): BridgeMethodHandler {
  const handler = createNetworkHandlers(options).fetch;
  if (!handler) {
    throw new Error('createNetworkHandlers must expose a fetch method');
  }
  return handler;
}

function setup(
  options: Parameters<typeof createNetworkHandlers>[0] = {},
  response: Response | Promise<Response> = okResponse(),
) {
  const fetchImpl = vi.fn().mockResolvedValue(response) as unknown as typeof fetch;
  return {
    fetchImpl: fetchImpl as unknown as ReturnType<typeof vi.fn>,
    fetch: networkFetchHandler({ fetchImpl, ...options }),
  };
}

type FetchInit = NonNullable<Parameters<typeof fetch>[1]>;

function lastInit(fetchImpl: ReturnType<typeof vi.fn>): FetchInit {
  return fetchImpl.mock.calls[0]?.[1] as FetchInit;
}

describe('isLoopbackHostname', () => {
  it.each(['localhost', '127.0.0.1', '[::1]'])('matches %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(true);
  });

  it.each([
    '::1', // URL.hostname always brackets IPv6 — the bare form must never match
    'evil-localhost',
    'localhost.evil.com',
    'api.example.com',
    '127.0.0.2',
  ])('does not match %s', (hostname) => {
    expect(isLoopbackHostname(hostname)).toBe(false);
  });
});

describe('network.fetch allowlist', () => {
  it('performs a request to an allowlisted host', async () => {
    const { fetch, fetchImpl } = setup();
    const result = await fetch({ url: 'https://api.example.com/items' }, CTX);

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/items');
    expect(result).toMatchObject({ status: 200, body: 'hello' });
  });

  it('denies a host absent from the allowlist', async () => {
    const { fetch, fetchImpl } = setup();
    await expect(fetch({ url: 'https://not-allowed.example.com/' }, CTX)).rejects.toBeInstanceOf(
      BridgePermissionDeniedError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    'https://evil-api.example.com/',
    'https://api.example.com.evil.com/',
    'https://sub.api.example.com/',
    'https://pi.example.com/',
  ])('denies near-miss hostname %s (exact match only)', async (url) => {
    const { fetch } = setup();
    await expect(fetch({ url }, CTX)).rejects.toBeInstanceOf(BridgePermissionDeniedError);
  });

  it('denies every host when the manifest declares no network block', async () => {
    const { fetch } = setup();
    const ctx = { manifest: { ...MANIFEST, network: undefined } } as BridgeHandlerContext;
    await expect(fetch({ url: 'https://api.example.com/' }, ctx)).rejects.toBeInstanceOf(
      BridgePermissionDeniedError,
    );
  });
});

describe('network.fetch URL contract', () => {
  it.each(['file:///etc/passwd', 'ftp://api.example.com/', 'data:text/plain,hi'])(
    'rejects unsupported scheme %s',
    async (url) => {
      const { fetch, fetchImpl } = setup();
      await expect(fetch({ url }, CTX)).rejects.toBeInstanceOf(BridgeInvalidParamsError);
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  it('rejects a URL embedding credentials', async () => {
    const { fetch, fetchImpl } = setup();
    await expect(fetch({ url: 'https://user:pass@api.example.com/' }, CTX)).rejects.toThrow(
      /must not embed credentials/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects a non-absolute URL', async () => {
    const { fetch } = setup();
    await expect(fetch({ url: '/relative/path' }, CTX)).rejects.toBeInstanceOf(BridgeInvalidParamsError);
  });

  it('rejects a non-default https port', async () => {
    const { fetch, fetchImpl } = setup();
    await expect(fetch({ url: 'https://api.example.com:8443/' }, CTX)).rejects.toThrow(
      /only the default https port/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['https://api.example.com/', 'https://api.example.com:443/'])(
    'accepts the default https port in %s',
    async (url) => {
      const { fetch } = setup();
      await expect(fetch({ url }, CTX)).resolves.toMatchObject({ status: 200 });
    },
  );
});

describe('network.fetch http loopback exception', () => {
  const LOOPBACK_URLS = [
    'http://localhost:5173/api',
    'http://127.0.0.1:8080/api',
    'http://[::1]:3000/api',
  ];

  it.each(LOOPBACK_URLS)('accepts %s when the dev/test flag is enabled', async (url) => {
    const { fetch } = setup({ allowInsecureLoopback: true });
    await expect(fetch({ url }, CTX)).resolves.toMatchObject({ status: 200 });
  });

  it.each(LOOPBACK_URLS)('rejects %s when the flag is disabled (the default)', async (url) => {
    const { fetch, fetchImpl } = setup();
    await expect(fetch({ url }, CTX)).rejects.toBeInstanceOf(BridgeInvalidParamsError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('still rejects non-loopback http even when the flag is enabled', async () => {
    const { fetch, fetchImpl } = setup({ allowInsecureLoopback: true });
    await expect(fetch({ url: 'http://api.example.com/' }, CTX)).rejects.toThrow(/unsupported URL scheme/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('network.fetch method contract', () => {
  it.each(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])('accepts %s', async (method) => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/', method }, CTX);
    expect(lastInit(fetchImpl).method).toBe(method);
  });

  it.each(['OPTIONS', 'TRACE', 'CONNECT', 'get', 'FROBNICATE'])('rejects %s', async (method) => {
    const { fetch, fetchImpl } = setup();
    await expect(fetch({ url: 'https://api.example.com/', method }, CTX)).rejects.toBeInstanceOf(
      BridgeInvalidParamsError,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('defaults to GET', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/' }, CTX);
    expect(lastInit(fetchImpl).method).toBe('GET');
  });
});

describe('network.fetch GET/HEAD body rule', () => {
  it.each(['GET', 'HEAD'])('rejects a non-empty body on %s before fetching', async (method) => {
    const { fetch, fetchImpl } = setup();
    await expect(
      fetch({ url: 'https://api.example.com/', method, body: '{"a":1}' }, CTX),
    ).rejects.toThrow(/"body" is not allowed for a (GET|HEAD) request/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ['GET', undefined],
    ['GET', ''],
    ['HEAD', undefined],
    ['HEAD', ''],
  ])('omits the body key entirely for %s with body %j', async (method, body) => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/', method, body }, CTX);
    // Not `body: ''` — the Fetch Standard rejects a GET/HEAD whose body
    // merely exists, empty or not.
    expect('body' in lastInit(fetchImpl)).toBe(false);
  });

  it('still allows an empty body on POST', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/', method: 'POST', body: '' }, CTX);
    expect(lastInit(fetchImpl).method).toBe('POST');
  });

  it('sends a non-empty body on POST', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/', method: 'POST', body: '{"a":1}' }, CTX);
    expect(lastInit(fetchImpl).body).toBe('{"a":1}');
  });
});

describe('network.fetch header contract', () => {
  it.each([
    'cookie',
    'Cookie',
    'COOKIE',
    'host',
    'origin',
    'referer',
    'content-length',
    'connection',
    'transfer-encoding',
    'upgrade',
    'proxy-authorization',
    'Proxy-Connection',
    'sec-fetch-mode',
    'Sec-Ch-Ua',
  ])('rejects the %s header (normalized before checking)', async (name) => {
    const { fetch, fetchImpl } = setup();
    await expect(
      fetch({ url: 'https://api.example.com/', headers: { [name]: 'x' } }, CTX),
    ).rejects.toThrow(/controlled by the host/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(['authorization', 'Authorization', 'AUTHORIZATION'])('passes %s through', async (name) => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/', headers: { [name]: 'Bearer app-token' } }, CTX);
    expect(lastInit(fetchImpl).headers).toMatchObject({ authorization: 'Bearer app-token' });
  });

  it('passes ordinary application headers through, lowercased', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch(
      {
        url: 'https://api.example.com/',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': 'k' },
      },
      CTX,
    );
    expect(lastInit(fetchImpl).headers).toEqual({
      'content-type': 'application/json',
      'x-api-key': 'k',
    });
  });

  it('rejects a non-string header value', async () => {
    const { fetch } = setup();
    await expect(
      fetch({ url: 'https://api.example.com/', headers: { 'x-a': 1 } }, CTX),
    ).rejects.toBeInstanceOf(BridgeInvalidParamsError);
  });
});

describe('network.fetch host-fixed transport options', () => {
  it('always sends credentials omit, redirect error, referrerPolicy no-referrer', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/' }, CTX);

    expect(lastInit(fetchImpl)).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
  });

  it('ignores transport overrides smuggled into params, since the contract has no such fields', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch(
      {
        url: 'https://api.example.com/',
        // Not part of NetworkFetchRequest — a malicious client can still put
        // them on the wire, so the host must not read them.
        credentials: 'include',
        redirect: 'follow',
        referrerPolicy: 'unsafe-url',
        mode: 'no-cors',
        keepalive: true,
      } as unknown,
      CTX,
    );

    expect(lastInit(fetchImpl)).toMatchObject({
      credentials: 'omit',
      redirect: 'error',
      referrerPolicy: 'no-referrer',
    });
    expect(lastInit(fetchImpl)).not.toHaveProperty('mode');
    expect(lastInit(fetchImpl)).not.toHaveProperty('keepalive');
  });

  it('passes an AbortSignal the host owns', async () => {
    const { fetch, fetchImpl } = setup();
    await fetch({ url: 'https://api.example.com/' }, CTX);
    expect(lastInit(fetchImpl).signal).toBeInstanceOf(AbortSignal);
  });
});

describe('network.fetch failure classification', () => {
  it('reports a rejected fetch as the generic NETWORK_REQUEST_FAILED', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    const fetchHandler = networkFetchHandler({ fetchImpl });

    await expect(fetchHandler({ url: 'https://api.example.com/' }, CTX)).rejects.toMatchObject({
      code: 'NETWORK_REQUEST_FAILED',
    });
  });

  it('reports a blocked redirect and a CORS rejection identically', async () => {
    // Both reach us as a bare TypeError with no cause attached, so the host
    // genuinely cannot tell them apart. Pinned so a future change cannot
    // quietly start claiming a distinction that does not exist.
    const redirectBlocked = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;
    const corsRejected = vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as unknown as typeof fetch;

    const redirectError = await Promise.resolve(
      networkFetchHandler({ fetchImpl: redirectBlocked })({ url: 'https://api.example.com/' }, CTX),
    ).catch((error: BridgeNetworkError) => error);
    const corsError = await Promise.resolve(
      networkFetchHandler({ fetchImpl: corsRejected })({ url: 'https://api.example.com/' }, CTX),
    ).catch((error: BridgeNetworkError) => error);

    expect((redirectError as BridgeNetworkError).code).toBe('NETWORK_REQUEST_FAILED');
    expect((corsError as BridgeNetworkError).code).toBe((redirectError as BridgeNetworkError).code);
  });

  it('reports a timeout distinctly, because the host caused it', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: FetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
        }),
    ) as unknown as typeof fetch;

    const fetchHandler = networkFetchHandler({ fetchImpl, timeoutMs: 10 });
    await expect(fetchHandler({ url: 'https://api.example.com/' }, CTX)).rejects.toMatchObject({
      code: 'NETWORK_TIMEOUT',
    });
  });
});

describe('network.fetch size limits', () => {
  it('rejects a request body over the limit before sending', async () => {
    const { fetch, fetchImpl } = setup({ maxRequestBodyBytes: 16 });
    await expect(
      fetch({ url: 'https://api.example.com/', method: 'POST', body: 'x'.repeat(17) }, CTX),
    ).rejects.toMatchObject({ code: 'NETWORK_REQUEST_TOO_LARGE' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('accepts a request body exactly at the limit', async () => {
    const { fetch } = setup({ maxRequestBodyBytes: 16 });
    await expect(
      fetch({ url: 'https://api.example.com/', method: 'POST', body: 'x'.repeat(16) }, CTX),
    ).resolves.toMatchObject({ status: 200 });
  });

  it('measures the request body in bytes, not characters', async () => {
    const { fetch } = setup({ maxRequestBodyBytes: 4 });
    // Three 3-byte characters = 9 bytes, though only 3 UTF-16 units.
    await expect(
      fetch({ url: 'https://api.example.com/', method: 'POST', body: '€€€' }, CTX),
    ).rejects.toMatchObject({ code: 'NETWORK_REQUEST_TOO_LARGE' });
  });

  it('aborts a response body over the limit', async () => {
    const { fetch } = setup({ maxResponseBodyBytes: 8 }, okResponse('x'.repeat(64)));
    await expect(fetch({ url: 'https://api.example.com/' }, CTX)).rejects.toMatchObject({
      code: 'NETWORK_RESPONSE_TOO_LARGE',
    });
  });

  it('enforces the response cap even when Content-Length lies', async () => {
    const lying = new Response('x'.repeat(64), {
      status: 200,
      headers: { 'content-type': 'text/plain', 'content-length': '2' },
    });
    const { fetch } = setup({ maxResponseBodyBytes: 8 }, lying);

    await expect(fetch({ url: 'https://api.example.com/' }, CTX)).rejects.toMatchObject({
      code: 'NETWORK_RESPONSE_TOO_LARGE',
    });
  });

  it('returns a response body at the limit intact', async () => {
    const { fetch } = setup({ maxResponseBodyBytes: 8 }, okResponse('12345678'));
    await expect(fetch({ url: 'https://api.example.com/' }, CTX)).resolves.toMatchObject({
      body: '12345678',
    });
  });

  it.each([
    ['a 204 with no content', new Response(null, { status: 204 })],
    ['a 304 with no content', new Response(null, { status: 304 })],
  ])('reads %s as an empty body rather than failing', async (_label, response) => {
    // `response.body` is null for these, and for a real HEAD response — a
    // reachable case, since HEAD is on the method allowlist — so the reader
    // path must not be entered at all.
    const { fetch } = setup({}, response);
    await expect(fetch({ url: 'https://api.example.com/', method: 'HEAD' }, CTX)).resolves.toMatchObject({
      status: response.status,
      body: '',
    });
  });
});

describe('network.fetch response shape', () => {
  it('returns status, statusText, lowercased headers and body', async () => {
    const response = new Response('{"ok":true}', {
      status: 201,
      statusText: 'Created',
      headers: { 'Content-Type': 'application/json', 'X-Trace': 'abc' },
    });
    const { fetch } = setup({}, response);

    await expect(fetch({ url: 'https://api.example.com/' }, CTX)).resolves.toEqual({
      status: 201,
      statusText: 'Created',
      headers: expect.objectContaining({ 'content-type': 'application/json', 'x-trace': 'abc' }),
      body: '{"ok":true}',
    });
  });

  it('relays a non-2xx response as a normal result, not an error', async () => {
    const { fetch } = setup({}, okResponse('nope', { status: 404 }));
    await expect(fetch({ url: 'https://api.example.com/' }, CTX)).resolves.toMatchObject({
      status: 404,
      body: 'nope',
    });
  });
});

describe('network.fetch params validation', () => {
  it.each([null, 'https://api.example.com/', [], {}, { url: '' }, { url: 42 }])(
    'rejects malformed params %j',
    async (params) => {
      const { fetch } = setup();
      await expect(fetch(params, CTX)).rejects.toBeInstanceOf(BridgeInvalidParamsError);
    },
  );

  it('rejects a non-string body', async () => {
    const { fetch } = setup();
    await expect(
      fetch({ url: 'https://api.example.com/', method: 'POST', body: { a: 1 } }, CTX),
    ).rejects.toBeInstanceOf(BridgeInvalidParamsError);
  });

  it('rejects a non-object headers value', async () => {
    const { fetch } = setup();
    await expect(
      fetch({ url: 'https://api.example.com/', headers: 'x-a: 1' }, CTX),
    ).rejects.toBeInstanceOf(BridgeInvalidParamsError);
  });
});
