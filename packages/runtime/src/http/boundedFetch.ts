/**
 * A `fetch` whose size cap and deadline actually hold.
 *
 * Two properties are easy to claim and easy to get wrong, so they are stated
 * here explicitly:
 *
 * - **The cap is enforced while bytes are read**, not after. A limit checked
 *   once `response.text()` has resolved is not a limit — the unbounded
 *   allocation has already happened. Received bytes are counted per chunk and
 *   the reader is cancelled the moment the cap is passed.
 * - **The deadline spans fetch *and* body read.** A timer covering only the
 *   fetch call leaves a stalled body stream unbounded, which is the more
 *   useful attack of the two. One `AbortController` is armed before the fetch
 *   and cleared in a `finally`.
 *
 * `Content-Length` is deliberately never consulted: a missing or dishonest
 * header must not be able to raise the ceiling.
 *
 * This logic was written for Phase 7's `network.fetch` and is extracted here
 * so the package-load path can reuse it rather than grow a second copy.
 * Duplication is this repository's recurring failure mode. Policy stays with
 * the callers — `credentials`, `referrerPolicy`, header collection and the
 * hostname allowlist are the network handler's concerns, not this module's —
 * and so does error vocabulary: this module throws a `BoundedFetchError`
 * carrying a `reason` discriminant, and each caller maps that to its own
 * error type and message.
 */

/**
 * Exactly what `fetch` accepts as its second argument, derived from `fetch`
 * itself rather than named as `RequestInit`. `RequestInit` is a type-only
 * global, so referring to it trips the lint config's `no-undef` (which only
 * knows about *runtime* globals), and the lint config is out of scope here.
 */
export type BoundedFetchInit = NonNullable<Parameters<typeof fetch>[1]>;

export type BoundedFetchFailureReason = 'timeout' | 'too-large' | 'failed';

export class BoundedFetchError extends Error {
  readonly reason: BoundedFetchFailureReason;

  constructor(reason: BoundedFetchFailureReason, message: string) {
    super(message);
    this.name = 'BoundedFetchError';
    this.reason = reason;
  }
}

export interface BoundedFetchOptions {
  /** Deadline for the whole fetch-and-body-read lifecycle. */
  timeoutMs: number;
  /** Hard cap on received response bytes. */
  maxBodyBytes: number;
  /** Seam for tests and for callers that supply their own fetch. */
  fetchImpl?: typeof fetch;
  /**
   * Retain the exact bytes received, in addition to the decoded text.
   *
   * Off by default, and deliberately opt-in: every existing caller wants
   * text and nothing else, and holding a second copy of every response body
   * for their benefit would be pure cost.
   *
   * It exists because a digest must cover the bytes that arrived, not a
   * re-encoding of the text they decoded to. Those are not the same thing:
   * invalid UTF-8 decodes to U+FFFD, so distinct byte sequences share one
   * string form, and `TextEncoder` would then hash a value the server never
   * sent. (`packages/shared/src/crypto.test.ts` pins exactly this.) A
   * verifier that re-encoded would fail honest packages and, worse, assign
   * one digest to two different payloads.
   */
  captureBytes?: boolean;
}

export interface BoundedFetchResult {
  response: Response;
  body: string;
  /**
   * The exact received bytes. Present if and only if `captureBytes` was set
   * — absent rather than empty when it was not, so a caller cannot mistake
   * "capture was off" for "the body was empty".
   */
  bytes?: Uint8Array;
}

/**
 * A body read under the cap: always its text, plus the raw bytes when the
 * caller asked for them.
 */
export interface BoundedBody {
  text: string;
  bytes?: Uint8Array;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * Reads the body while counting actual bytes, aborting the moment the cap is
 * passed. `onOverflow` lets the caller abort the surrounding request before
 * this throws, so the connection is not left draining.
 */
export async function readBoundedBody(
  response: Response,
  maxBodyBytes: number,
  onOverflow: () => void,
  captureBytes = false,
): Promise<BoundedBody> {
  const body = response.body;
  if (!body || typeof body.getReader !== 'function') {
    // `body` is null for a 204/304 and for a HEAD response, so this is a
    // normal path, not just a guard: there is nothing to stream and
    // `text()` yields ''. It also covers any environment lacking streaming
    // bodies, where the cap can only be checked after the fact.
    //
    // When capturing, the body is taken as an ArrayBuffer instead: a
    // response can only be consumed once, and `text()` would leave no way
    // back to the bytes that produced it.
    if (captureBytes) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > maxBodyBytes) {
        onOverflow();
        throw new BoundedFetchError(
          'too-large',
          `response body exceeds the ${maxBodyBytes}-byte limit`,
        );
      }
      return { text: new TextDecoder().decode(bytes), bytes };
    }
    const text = await response.text();
    if (byteLength(text) > maxBodyBytes) {
      onOverflow();
      throw new BoundedFetchError(
        'too-large',
        `response body exceeds the ${maxBodyBytes}-byte limit`,
      );
    }
    return { text };
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  // Only allocated when capturing, so the default path keeps exactly its
  // previous allocation profile. Total retained length is bounded by
  // `maxBodyBytes`, which is checked below before any chunk is kept.
  const chunks: Uint8Array[] = [];

  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > maxBodyBytes) {
      onOverflow();
      await reader.cancel().catch(() => undefined);
      throw new BoundedFetchError(
        'too-large',
        `response body exceeds the ${maxBodyBytes}-byte limit`,
      );
    }
    if (captureBytes) {
      chunks.push(value);
    }
    text += decoder.decode(value, { stream: true });
  }

  const full = text + decoder.decode();
  if (!captureBytes) {
    return { text: full };
  }

  // Joined once at the end rather than grown per chunk, so a body arriving
  // in n pieces costs one allocation instead of n. `set` copies out of each
  // chunk's *view*, so a chunk that is a window into a larger buffer
  // contributes only its own bytes — the same trap `sha256` documents.
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: full, bytes };
}

/**
 * Performs a request under a single deadline covering both the fetch and the
 * body read, returning the response together with its bounded body text.
 *
 * A `signal` supplied in `init` is ignored: this function owns the abort
 * signal, because it is the thing enforcing the deadline.
 */
export async function fetchBounded(
  url: string,
  init: BoundedFetchInit,
  options: BoundedFetchOptions,
): Promise<BoundedFetchResult> {
  const { timeoutMs, maxBodyBytes, fetchImpl, captureBytes = false } = options;

  const controller = new AbortController();
  // The signal alone can't say why we aborted, and the two reasons map to
  // different errors, so the reason is tracked explicitly.
  let abortReason: 'timeout' | 'response-too-large' | null = null;
  // Armed before the fetch so it covers the body read too, and cleared in the
  // `finally` below however this ends.
  const timer = setTimeout(() => {
    abortReason = 'timeout';
    controller.abort();
  }, timeoutMs);

  const doFetch = fetchImpl ?? fetch;

  try {
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: controller.signal });
    } catch {
      // A browser network error is a bare TypeError with no cause attached,
      // by design — a blocked redirect, a CORS rejection and a DNS/TLS
      // failure are genuinely indistinguishable here, so this must not guess
      // between them.
      throw abortReason === 'timeout'
        ? new BoundedFetchError('timeout', `request exceeded the ${timeoutMs}ms timeout`)
        : new BoundedFetchError('failed', 'network request failed');
    }

    const body = await readBoundedBody(
      response,
      maxBodyBytes,
      () => {
        abortReason = 'response-too-large';
        controller.abort();
      },
      captureBytes,
    );

    // `bytes` is spread in only when captured, so the property is genuinely
    // absent — not present-and-undefined — on the default path.
    return captureBytes
      ? { response, body: body.text, bytes: body.bytes }
      : { response, body: body.text };
  } catch (error) {
    if (error instanceof BoundedFetchError) {
      throw error;
    }
    // A failure *during* the body read, e.g. the timeout firing mid-stream.
    throw abortReason === 'timeout'
      ? new BoundedFetchError('timeout', `request exceeded the ${timeoutMs}ms timeout`)
      : new BoundedFetchError('failed', 'network request failed');
  } finally {
    clearTimeout(timer);
  }
}
