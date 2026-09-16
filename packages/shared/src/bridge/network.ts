/**
 * Wire contract for `openmini.network.fetch` (Phase 7). Like the rest of
 * this package it is pure types/constants so host and Mini App agree on the
 * shape without depending on each other.
 *
 * This is deliberately **not** the browser's `RequestInit`. Only the fields
 * Phase 7 intentionally supports exist here; there is no `redirect`,
 * `credentials`, `mode`, `referrer`/`referrerPolicy`, `keepalive` or
 * `signal` field, so a Mini App cannot override a transport/security
 * control — not because the host filters those fields out, but because
 * there is no channel through which to send them. The host builds the real
 * `RequestInit` itself. See docs/security/bridge.md.
 */

/** Frozen method allowlist. `OPTIONS` is excluded: CORS preflight is browser-managed. */
export const NETWORK_FETCH_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'] as const;
export type NetworkFetchMethod = (typeof NETWORK_FETCH_METHODS)[number];

/** Methods that must never carry a request body (the Fetch Standard throws for these). */
export const NETWORK_BODILESS_METHODS: readonly NetworkFetchMethod[] = ['GET', 'HEAD'];

export interface NetworkFetchRequest {
  /** Absolute URL. https only, except the config-gated http loopback dev/test exception. */
  url: string;
  /** Defaults to `GET`. */
  method?: NetworkFetchMethod;
  /** Ordinary application headers. Transport/browser-controlled names are rejected host-side. */
  headers?: Record<string, string>;
  /**
   * Bounded and fully buffered — never a stream. Must be empty/absent for
   * `GET`/`HEAD`. Text only: binary bodies (`ArrayBuffer`/`Blob`/`FormData`)
   * are deferred future work, not supported in Phase 7.
   */
  body?: string;
}

export interface NetworkFetchResponse {
  status: number;
  statusText: string;
  /** Lowercased header names. Cross-origin responses expose only CORS-safelisted headers. */
  headers: Record<string, string>;
  body: string;
}

export function isNetworkFetchMethod(value: unknown): value is NetworkFetchMethod {
  return typeof value === 'string' && (NETWORK_FETCH_METHODS as readonly string[]).includes(value);
}
