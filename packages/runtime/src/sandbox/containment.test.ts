import { describe, expect, it } from 'vitest';
import { resolveContainedPath } from './containment';

describe('resolveContainedPath', () => {
  it.each([
    ['index.html'],
    ['assets/icon.png'],
    ['a/b/c.html'],
    ['./index.html'],
    ['a/./b.html'],
  ])('accepts valid relative path %s', (input) => {
    const result = resolveContainedPath(input);
    expect(result.ok).toBe(true);
  });

  it.each([
    ['../secret.html'],
    ['a/../../b.html'],
    ['%2e%2e/secret.html'],
    ['a/%2e%2e/b.html'],
  ])('rejects traversal in %s', (input) => {
    const result = resolveContainedPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('TRAVERSAL');
    }
  });

  it('rejects double-encoded traversal', () => {
    const result = resolveContainedPath('%252e%252e/secret.html');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('INVALID_SEGMENT');
    }
  });

  it.each([['/index.html'], ['\\index.html'], ['C:\\Windows\\x'], ['C:/Windows/x'], ['\\\\host\\share']])(
    'rejects absolute path %s',
    (input) => {
      const result = resolveContainedPath(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('ABSOLUTE_PATH');
      }
    },
  );

  it.each([
    ['https://example.com'],
    ['file:///etc/passwd'],
    ['//attacker.example/x'],
    // A bare `scheme:` with no `//` is still absolute to the WHATWG parser,
    // and resolves away from the package base. See containmentResolution.test.
    ['https:evil.com'],
    ['https:/evil.com'],
    ['https:\\\\evil.com'],
    ['data:text/html,x'],
    ['javascript:alert(1)'],
    ['about:blank'],
    // The accepted cost of matching a bare scheme: a colon anywhere in the
    // first segment is now rejected. Such names are unusable on Windows.
    ['my:file.html'],
  ])(
    'rejects URL-like entry %s',
    (input) => {
      const result = resolveContainedPath(input);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('SCHEME_LIKE');
      }
    },
  );

  it.each([[''], ['   '], ['.'], ['./']])('rejects empty-equivalent input %s', (input) => {
    const result = resolveContainedPath(input);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('EMPTY');
    }
  });

  it('rejects non-string input', () => {
    // @ts-expect-error deliberately passing a non-string to prove runtime guard
    const result = resolveContainedPath(undefined);
    expect(result.ok).toBe(false);
  });

  it('returns split, decoded segments on success', () => {
    const result = resolveContainedPath('a/b/c.html');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.segments).toEqual(['a', 'b', 'c.html']);
    }
  });
});
