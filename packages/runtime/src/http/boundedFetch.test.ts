import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BoundedFetchError,
  fetchBounded,
  readBoundedBody,
  type BoundedFetchInit,
} from './boundedFetch';

const encoder = new TextEncoder();

function chunk(text: string): Uint8Array {
  return encoder.encode(text);
}

/**
 * A response whose body is a real pull-based stream, so the cap can be
 * observed being enforced *during* the read rather than after it. `pulled`
 * records what was actually handed over and `cancelled` whether the reader
 * was shut down, which is the difference between a cap and a post-hoc check.
 */
function streamingResponse(
  chunks: Uint8Array[],
  extra: { contentLength?: string; status?: number } = {},
) {
  const pulled: Uint8Array[] = [];
  const state = { cancelled: false, index: 0 };

  const response = {
    status: extra.status ?? 200,
    statusText: 'OK',
    headers: new Headers(
      extra.contentLength === undefined ? {} : { 'content-length': extra.contentLength },
    ),
    body: {
      getReader: () => ({
        read: async () => {
          if (state.index >= chunks.length) {
            return { done: true, value: undefined };
          }
          const value = chunks[state.index] as Uint8Array;
          state.index += 1;
          pulled.push(value);
          return { done: false, value };
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

  return { response, pulled, state };
}

/** A body-less response: 204/304 and every HEAD reply look like this. */
function bodylessResponse(text: string, status = 204) {
  return {
    status,
    statusText: 'No Content',
    headers: new Headers(),
    body: null,
    text: async () => text,
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('readBoundedBody', () => {
  it('returns the decoded body when it fits', async () => {
    const { response } = streamingResponse([chunk('hello '), chunk('world')]);
    await expect(readBoundedBody(response, 1024, () => undefined)).resolves.toBe('hello world');
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const bytes = chunk('héllo');
    const { response } = streamingResponse([bytes.slice(0, 2), bytes.slice(2)]);
    // A naive per-chunk decode would produce a replacement character here.
    await expect(readBoundedBody(response, 1024, () => undefined)).resolves.toBe('héllo');
  });

  it('stops reading mid-stream once the cap is passed, and cancels the reader', async () => {
    const { response, pulled, state } = streamingResponse([
      chunk('a'.repeat(8)),
      chunk('b'.repeat(8)),
      chunk('c'.repeat(8)),
      chunk('d'.repeat(8)),
    ]);
    const onOverflow = vi.fn();

    await expect(readBoundedBody(response, 10, onOverflow)).rejects.toMatchObject({
      reason: 'too-large',
    });

    // The cap is 10 bytes and chunks are 8, so it must stop after the second:
    // the remaining 16 bytes were never pulled, let alone accumulated.
    expect(pulled).toHaveLength(2);
    expect(state.cancelled).toBe(true);
    expect(onOverflow).toHaveBeenCalledTimes(1);
  });

  it('ignores Content-Length entirely, including when it understates the body', async () => {
    const { response } = streamingResponse([chunk('x'.repeat(50))], { contentLength: '5' });

    // Trusting the header would have waved this through as a 5-byte body.
    await expect(readBoundedBody(response, 10, () => undefined)).rejects.toMatchObject({
      reason: 'too-large',
    });
  });

  it('accepts a body of exactly the cap', async () => {
    const { response } = streamingResponse([chunk('x'.repeat(10))]);
    await expect(readBoundedBody(response, 10, () => undefined)).resolves.toBe('x'.repeat(10));
  });

  describe('body === null fallback (204/304/HEAD, and environments without streams)', () => {
    it('reads through text() and yields the empty string', async () => {
      await expect(readBoundedBody(bodylessResponse(''), 10, () => undefined)).resolves.toBe('');
    });

    it('still applies the cap when text() returns more than it should', async () => {
      const onOverflow = vi.fn();
      await expect(
        readBoundedBody(bodylessResponse('x'.repeat(50), 200), 10, onOverflow),
      ).rejects.toMatchObject({ reason: 'too-large' });
      expect(onOverflow).toHaveBeenCalledTimes(1);
    });

    it('measures the cap in bytes, not characters', async () => {
      // 4 characters, 12 bytes.
      await expect(
        readBoundedBody(bodylessResponse('😀😀😀', 200), 8, () => undefined),
      ).rejects.toMatchObject({ reason: 'too-large' });
    });
  });
});

describe('fetchBounded', () => {
  it('returns the response and its body on success, and clears the timer', async () => {
    vi.useFakeTimers();
    const { response } = streamingResponse([chunk('ok')]);
    const fetchImpl = vi.fn().mockResolvedValue(response);

    const result = await fetchBounded(
      'https://api.example.com/',
      { method: 'GET' },
      { timeoutMs: 1000, maxBodyBytes: 1024, fetchImpl },
    );

    expect(result.body).toBe('ok');
    expect(result.response.status).toBe(200);
    // A leaked timer would keep the process alive for the full deadline.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('owns the abort signal, ignoring any the caller passes in', async () => {
    const callerController = new AbortController();
    const { response } = streamingResponse([chunk('ok')]);
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await fetchBounded(
      'https://api.example.com/',
      { method: 'GET', signal: callerController.signal },
      { timeoutMs: 1000, maxBodyBytes: 1024, fetchImpl },
    );

    const passed = (fetchImpl.mock.calls[0] as [string, BoundedFetchInit])[1];
    expect(passed.signal).toBeInstanceOf(AbortSignal);
    expect(passed.signal).not.toBe(callerController.signal);
  });

  it('forwards the caller’s init otherwise, unchanged', async () => {
    const { response } = streamingResponse([chunk('ok')]);
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await fetchBounded(
      'https://api.example.com/',
      { method: 'POST', redirect: 'error', credentials: 'omit', body: 'hi' },
      { timeoutMs: 1000, maxBodyBytes: 1024, fetchImpl },
    );

    expect(fetchImpl.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      credentials: 'omit',
      body: 'hi',
    });
  });

  it('reports a rejected fetch as "failed", not as a timeout', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));

    const error = await fetchBounded(
      'https://api.example.com/',
      {},
      { timeoutMs: 1000, maxBodyBytes: 1024, fetchImpl },
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BoundedFetchError);
    expect((error as BoundedFetchError).reason).toBe('failed');
  });

  it('reports "too-large" for an oversized body', async () => {
    const { response, state } = streamingResponse([chunk('x'.repeat(100))]);
    const fetchImpl = vi.fn().mockResolvedValue(response);

    const error = await fetchBounded(
      'https://api.example.com/',
      {},
      { timeoutMs: 1000, maxBodyBytes: 10, fetchImpl },
    ).catch((e: unknown) => e);

    expect((error as BoundedFetchError).reason).toBe('too-large');
    expect(state.cancelled).toBe(true);
  });

  it('times out a fetch that never resolves', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(
      (_url: string, init: BoundedFetchInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );

    const settled = fetchBounded(
      'https://api.example.com/',
      {},
      { timeoutMs: 500, maxBodyBytes: 1024, fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(500);

    expect(((await settled) as BoundedFetchError).reason).toBe('timeout');
  });

  // This is the property a fetch-only timer does not give you: headers arrive
  // promptly and the body then stalls forever, which is the cheaper attack.
  it('times out a response that stalls *after* headers, proving the deadline spans the body read', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    let reads = 0;

    // Headers arrive immediately; the body then hangs. Aborting the signal
    // rejects the in-flight read, which is what a real stream does — without
    // that, nothing would ever settle and the test could not tell a working
    // deadline from a hung one.
    const stalling = {
      status: 200,
      statusText: 'OK',
      headers: new Headers(),
      body: {
        getReader: () => ({
          read: () => {
            reads += 1;
            return new Promise((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted')));
            });
          },
          cancel: async () => undefined,
        }),
      },
      text: async () => '',
    } as unknown as Response;

    const fetchImpl = vi.fn((_url: string, init: BoundedFetchInit) => {
      signal = init.signal ?? undefined;
      return Promise.resolve(stalling);
    });

    const settled = fetchBounded(
      'https://api.example.com/',
      {},
      { timeoutMs: 500, maxBodyBytes: 1024, fetchImpl: fetchImpl as unknown as typeof fetch },
    ).catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(500);

    const error = (await settled) as BoundedFetchError;
    expect(error).toBeInstanceOf(BoundedFetchError);
    expect(error.reason).toBe('timeout');
    // The fetch itself succeeded; the deadline fired during the body read.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reads).toBe(1);
  });
});
