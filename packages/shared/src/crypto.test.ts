import { describe, expect, it } from 'vitest';
import {
  base64ToBytes,
  base64UrlEncode,
  bytesToBase64,
  digestsEqual,
  sha256,
  sha256Base64,
  sha256Base64Utf8,
} from './crypto';

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

describe('sha256', () => {
  it('matches the published NIST vector for "abc"', async () => {
    // FIPS 180-4 sample: the point of pinning a published vector rather than a
    // self-generated one is that it catches an implementation that is merely
    // self-consistent, which is exactly the failure a cross-package digest has.
    expect(bytesToBase64(await sha256(utf8('abc')))).toBe(
      'ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    );
  });

  it('matches the published vector for the empty input', async () => {
    expect(bytesToBase64(await sha256(new Uint8Array(0)))).toBe(
      '47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=',
    );
  });

  it('hashes the view, not the whole backing buffer', async () => {
    // A streamed chunk is a view into a larger buffer. Hashing `bytes.buffer`
    // instead of the view would silently digest neighbouring bytes.
    const backing = utf8('XXXabcXXX');
    const view = new Uint8Array(backing.buffer, 3, 3);
    expect(bytesToBase64(await sha256(view))).toBe(bytesToBase64(await sha256(utf8('abc'))));
  });

  it('distinguishes byte sequences that decode to the same string', async () => {
    // The reason integrity must digest bytes and never a decoded string:
    // invalid UTF-8 decodes to U+FFFD, so two different byte sequences share
    // one string form. Their digests must not collide.
    const invalidA = new Uint8Array([0xff]);
    const invalidB = new Uint8Array([0xfe]);
    expect(new TextDecoder().decode(invalidA)).toBe(new TextDecoder().decode(invalidB));
    expect(await sha256Base64(invalidA)).not.toBe(await sha256Base64(invalidB));
  });
});

describe('sha256Base64', () => {
  it('carries the algorithm prefix', async () => {
    expect(await sha256Base64(utf8('abc'))).toBe(
      'sha256-ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=',
    );
  });

  it('agrees with the text convenience wrapper', async () => {
    expect(await sha256Base64Utf8('hello')).toBe(await sha256Base64(utf8('hello')));
  });
});

describe('base64', () => {
  it('round-trips arbitrary bytes, including non-UTF-8 ones', () => {
    const bytes = new Uint8Array([0, 1, 250, 251, 252, 253, 254, 255]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('round-trips every byte value', () => {
    const all = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      all[i] = i;
    }
    expect(base64ToBytes(bytesToBase64(all))).toEqual(all);
  });

  it('rejects malformed input rather than returning truncated bytes', () => {
    expect(() => base64ToBytes('not!valid!base64')).toThrow(/invalid base64/);
  });

  it('encodes base64url without padding or the + and / characters', () => {
    // 0xfb 0xff standard-encodes to "+/8=", which exercises all three
    // substitutions at once.
    const bytes = new Uint8Array([0xfb, 0xff]);
    expect(bytesToBase64(bytes)).toBe('+/8=');
    expect(base64UrlEncode(bytes)).toBe('-_8');
  });
});

describe('digestsEqual', () => {
  it('accepts identical digests', () => {
    expect(digestsEqual('sha256-abc', 'sha256-abc')).toBe(true);
  });

  it('rejects a single-character difference', () => {
    expect(digestsEqual('sha256-abc', 'sha256-abd')).toBe(false);
  });

  it('rejects differing lengths', () => {
    expect(digestsEqual('sha256-abc', 'sha256-abcd')).toBe(false);
  });

  it('rejects a prefix of a longer digest', () => {
    expect(digestsEqual('', 'sha256-abc')).toBe(false);
  });
});
