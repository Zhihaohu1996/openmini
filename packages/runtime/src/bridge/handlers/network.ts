import {
  NETWORK_BODILESS_METHODS,
  isNetworkFetchMethod,
  type NetworkFetchMethod,
  type NetworkFetchRequest,
  type NetworkFetchResponse,
} from '@openmini/shared';
import { BridgeInvalidParamsError, BridgeNetworkError, BridgePermissionDeniedError } from '../errors';
import type { BridgeHandlerContext, BridgeMethodHandler } from '../types';

/** See docs/security/bridge.md's "network.fetch" section for the normative rules these implement. */
export const NETWORK_MAX_REQUEST_BODY_BYTES = 1_048_576;
export const NETWORK_MAX_RESPONSE_BODY_BYTES = 5_242_880;
export const NETWORK_REQUEST_TIMEOUT_MS = 30_000;

/**
 * The only hosts the `http:` dev/test exception may ever apply to, in the
 * exact spelling `URL.hostname` produces: lowercase, and — for IPv6 —
 * bracketed. `new URL('http://[::1]:3000/').hostname` is the string
 * `'[::1]'`, never bare `'::1'`, so this set is written the same way and
 * every caller compares against it directly rather than re-deriving or
 * unbracketing the host.
 */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(hostname);
}

/**
 * Header names a Mini App may never set. These are transport- or
 * browser-controlled: some let a request impersonate browser-level state
 * (`cookie`, `origin`, `referer`), others could desync or smuggle a request
 * if authored by hand (`content-length`, `transfer-encoding`, `connection`,
 * `upgrade`). `authorization` is deliberately NOT here — an app-supplied
 * bearer token is application data, unrelated to the host's ambient
 * credentials, which `credentials: 'omit'` keeps out regardless.
 */
const BLOCKED_HEADERS: ReadonlySet<string> = new Set([
  'cookie',
  'host',
  'origin',
  'referer',
  'content-length',
  'connection',
  'transfer-encoding',
  'upgrade',
]);
const BLOCKED_HEADER_PREFIXES = ['proxy-', 'sec-'];

function isBlockedHeader(lowercasedName: string): boolean {
  return (
    BLOCKED_HEADERS.has(lowercasedName) ||
    BLOCKED_HEADER_PREFIXES.some((prefix) => lowercasedName.startsWith(prefix))
  );
}

export interface NetworkHandlerOptions {
  /**
   * Allows plain `http:` to loopback hosts only. Defaults to `false`, and
   * must stay false in any production embedding: without this gate the
   * "dev/test only" claim would rest on hostname shape alone.
   */
  allowInsecureLoopback?: boolean;
  /** Defaults to 30000ms. Covers the request through the full bounded body read. */
  timeoutMs?: number;
  /** Defaults to 1 MiB. */
  maxRequestBodyBytes?: number;
  /** Defaults to 5 MiB. */
  maxResponseBodyBytes?: number;
  /** Defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: typeof fetch;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function readParams(params: unknown): NetworkFetchRequest {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) {
    throw new BridgeInvalidParamsError('expected { url: string, ... }');
  }
  const record = params as Record<string, unknown>;

  if (typeof record.url !== 'string' || record.url.length === 0) {
    throw new BridgeInvalidParamsError('"url" must be a non-empty string');
  }

  if (record.method !== undefined && !isNetworkFetchMethod(record.method)) {
    throw new BridgeInvalidParamsError(
      `"method" must be one of GET, POST, PUT, PATCH, DELETE, HEAD (got ${JSON.stringify(record.method)})`,
    );
  }

  if (record.body !== undefined && record.body !== null && typeof record.body !== 'string') {
    throw new BridgeInvalidParamsError('"body" must be a string');
  }

  let headers: Record<string, string> | undefined;
  if (record.headers !== undefined) {
    if (typeof record.headers !== 'object' || record.headers === null || Array.isArray(record.headers)) {
      throw new BridgeInvalidParamsError('"headers" must be an object');
    }
    headers = {};
    for (const [name, value] of Object.entries(record.headers as Record<string, unknown>)) {
      if (typeof value !== 'string') {
        throw new BridgeInvalidParamsError(`header "${name}" must have a string value`);
      }
      const normalized = name.toLowerCase();
      if (isBlockedHeader(normalized)) {
        throw new BridgeInvalidParamsError(`header "${name}" is controlled by the host and cannot be set`);
      }
      headers[normalized] = value;
    }
  }

  return {
    url: record.url,
    method: record.method as NetworkFetchMethod | undefined,
    headers,
    body: typeof record.body === 'string' ? record.body : undefined,
  };
}

function resolveTargetUrl(rawUrl: string, allowInsecureLoopback: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BridgeInvalidParamsError('"url" must be an absolute URL');
  }

  if (url.username !== '' || url.password !== '') {
    throw new BridgeInvalidParamsError('"url" must not embed credentials');
  }

  if (url.protocol === 'https:') {
    // The manifest allowlist has no way to declare a port, so anything but
    // the default is unrepresentable rather than merely unusual. `port` is
    // '' exactly when the URL uses the scheme's default, including an
    // explicit ":443", which the URL parser normalizes away.
    if (url.port !== '') {
      throw new BridgeInvalidParamsError('only the default https port is allowed');
    }
    return url;
  }

  if (url.protocol === 'http:' && allowInsecureLoopback && isLoopbackHostname(url.hostname)) {
    return url;
  }

  throw new BridgeInvalidParamsError(`unsupported URL scheme: ${url.protocol}`);
}

function assertHostAllowed(url: URL, ctx: BridgeHandlerContext): void {
  const domains = ctx.manifest.network?.domains ?? [];
  if (!domains.includes(url.hostname)) {
    throw new BridgePermissionDeniedError('this Mini App does not have the required permission');
  }
}

function resolveBody(method: NetworkFetchMethod, body: string | undefined, maxRequestBodyBytes: number): string | undefined {
  const hasBody = body !== undefined && body.length > 0;

  if (NETWORK_BODILESS_METHODS.includes(method)) {
    if (hasBody) {
      throw new BridgeInvalidParamsError(`"body" is not allowed for a ${method} request`);
    }
    // Omitted entirely rather than passed as '': the Fetch Standard rejects
    // a GET/HEAD whose body merely *exists*, empty or not.
    return undefined;
  }

  if (hasBody && byteLength(body) > maxRequestBodyBytes) {
    throw new BridgeNetworkError(
      'NETWORK_REQUEST_TOO_LARGE',
      `request body exceeds the ${maxRequestBodyBytes}-byte limit`,
    );
  }

  return body;
}

function collectResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name.toLowerCase()] = value;
  });
  return headers;
}

/**
 * Reads the body while counting actual bytes, aborting the moment the cap is
 * passed. Deliberately ignores `Content-Length`: a missing or dishonest
 * header must not be able to raise the ceiling.
 */
async function readBoundedBody(
  response: Response,
  maxResponseBodyBytes: number,
  onOverflow: () => void,
): Promise<string> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // `body` is null for a 204/304 and for a HEAD response, so this is a
    // normal path, not just a guard: there is nothing to stream and
    // `text()` yields ''. It also covers any environment lacking streaming
    // bodies, where the cap can only be checked after the fact.
    const text = await response.text();
    if (byteLength(text) > maxResponseBodyBytes) {
      onOverflow();
      throw new BridgeNetworkError(
        'NETWORK_RESPONSE_TOO_LARGE',
        `response body exceeds the ${maxResponseBodyBytes}-byte limit`,
      );
    }
    return text;
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxResponseBodyBytes) {
      onOverflow();
      await reader.cancel().catch(() => undefined);
      throw new BridgeNetworkError(
        'NETWORK_RESPONSE_TOO_LARGE',
        `response body exceeds the ${maxResponseBodyBytes}-byte limit`,
      );
    }
    text += decoder.decode(value, { stream: true });
  }

  return text + decoder.decode();
}

/**
 * `openmini.network.fetch` — host-mediated HTTP(S) request/response, gated
 * by the manifest's exact-hostname `network.domains` allowlist.
 *
 * The Mini App never touches the browser's `RequestInit`: it supplies only
 * method/headers/body, and the host assembles the real request itself with
 * `credentials: 'omit'`, `redirect: 'error'` and `referrerPolicy:
 * 'no-referrer'` fixed. The sandbox's own CSP keeps `connect-src 'none'`,
 * so this handler is the only way out, and every call is host-visible.
 *
 * Note this grants permission to *attempt* a request; it is not a CORS
 * bypass. A cross-origin target still has to allow the host's origin.
 */
export function createNetworkHandlers(options: NetworkHandlerOptions = {}): Record<string, BridgeMethodHandler> {
  const {
    allowInsecureLoopback = false,
    timeoutMs = NETWORK_REQUEST_TIMEOUT_MS,
    maxRequestBodyBytes = NETWORK_MAX_REQUEST_BODY_BYTES,
    maxResponseBodyBytes = NETWORK_MAX_RESPONSE_BODY_BYTES,
    fetchImpl,
  } = options;

  return {
    async fetch(params, ctx: BridgeHandlerContext): Promise<NetworkFetchResponse> {
      const request = readParams(params);
      const url = resolveTargetUrl(request.url, allowInsecureLoopback);
      assertHostAllowed(url, ctx);

      const method = request.method ?? 'GET';
      const body = resolveBody(method, request.body, maxRequestBodyBytes);

      const controller = new AbortController();
      // The signal alone can't say why we aborted, and the two reasons map
      // to different errors, so the reason is tracked explicitly.
      let abortReason: 'timeout' | 'response-too-large' | null = null;
      const timer = setTimeout(() => {
        abortReason = 'timeout';
        controller.abort();
      }, timeoutMs);

      const doFetch = fetchImpl ?? fetch;

      try {
        let response: Response;
        try {
          response = await doFetch(url.toString(), {
            method,
            headers: request.headers ?? {},
            ...(body === undefined ? {} : { body }),
            credentials: 'omit',
            redirect: 'error',
            referrerPolicy: 'no-referrer',
            signal: controller.signal,
          });
        } catch {
          // A browser network error is a bare TypeError with no cause
          // attached, by design — a blocked redirect, a CORS rejection and a
          // DNS/TLS failure are genuinely indistinguishable here, so this
          // must not guess between them.
          throw abortReason === 'timeout'
            ? new BridgeNetworkError('NETWORK_TIMEOUT', `request exceeded the ${timeoutMs}ms timeout`)
            : new BridgeNetworkError('NETWORK_REQUEST_FAILED', 'network request failed');
        }

        const responseBody = await readBoundedBody(response, maxResponseBodyBytes, () => {
          abortReason = 'response-too-large';
          controller.abort();
        });

        return {
          status: response.status,
          statusText: response.statusText,
          headers: collectResponseHeaders(response),
          body: responseBody,
        };
      } catch (error) {
        if (error instanceof BridgeNetworkError) {
          throw error;
        }
        // A failure *during* the body read, e.g. the timeout firing mid-stream.
        throw abortReason === 'timeout'
          ? new BridgeNetworkError('NETWORK_TIMEOUT', `request exceeded the ${timeoutMs}ms timeout`)
          : new BridgeNetworkError('NETWORK_REQUEST_FAILED', 'network request failed');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
