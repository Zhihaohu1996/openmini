/**
 * Fake `Response`s for exercising the bounded-fetch guarantees.
 *
 * Shared rather than duplicated per suite on purpose: these fixtures encode
 * details that are easy to get subtly wrong and that must agree with
 * `boundedFetch` to be meaningful — chunk sizes relative to the cap, and the
 * fact that aborting a real stream *rejects the in-flight read* rather than
 * leaving it pending. A copy that drifts on either point still passes while
 * testing nothing.
 *
 * Test-only. Not exported from the package index.
 */

import { PACKAGE_MAX_RESOURCE_BYTES } from '../sandbox/fetchResourceProvider';

const CHUNK_BYTES = 1_048_576;

export interface StreamState {
  /** How many chunks the consumer actually pulled. */
  pulled: number;
  /** Whether the reader was cancelled, i.e. the cap stopped the read. */
  cancelled: boolean;
}

/**
 * A streaming response comfortably larger than the package cap, delivered in
 * 1 MiB chunks so a correct reader trips the limit partway through and leaves
 * the tail unread. With the 5 MiB cap that is the 6th chunk; the extra chunks
 * beyond it exist precisely so "never pulled" is observable.
 */
export function oversizedStreamingResponse(extra: { contentLength?: string } = {}) {
  const totalChunks = Math.ceil(PACKAGE_MAX_RESOURCE_BYTES / CHUNK_BYTES) + 3;
  const state: StreamState = { pulled: 0, cancelled: false };

  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(
      extra.contentLength === undefined ? {} : { 'content-length': extra.contentLength },
    ),
    body: {
      getReader: () => ({
        read: async () => {
          if (state.pulled >= totalChunks) {
            return { done: true, value: undefined };
          }
          state.pulled += 1;
          return { done: false, value: new Uint8Array(CHUNK_BYTES) };
        },
        cancel: async () => {
          state.cancelled = true;
        },
      }),
    },
    text: async () => {
      throw new Error('text() must not be called when a streaming body is available');
    },
  } as unknown as Response;

  return { response, state };
}

/**
 * Headers arrive immediately; the body then hangs until the request is
 * aborted, at which point the pending read rejects — which is what a real
 * stream does. Without that rejection nothing would ever settle, and the test
 * could not tell a working deadline from a hung one.
 *
 * The caller must hand back the abort signal via `setSignal`, because the
 * signal is created inside `fetchBounded`, not by the test.
 */
export function stallingResponse() {
  let signal: AbortSignal | undefined;

  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          }),
        cancel: async () => undefined,
      }),
    },
    text: async () => '',
  } as unknown as Response;

  return {
    response,
    setSignal: (next: AbortSignal | undefined | null) => {
      signal = next ?? undefined;
    },
  };
}
