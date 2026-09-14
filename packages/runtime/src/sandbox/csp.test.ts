import { describe, expect, it } from 'vitest';
import { MINI_APP_BASE_CSP_DIRECTIVES, MINI_APP_SANDBOX_ATTRIBUTE, buildMiniAppCsp } from './csp';

describe('MINI_APP_SANDBOX_ATTRIBUTE', () => {
  it('is exactly allow-scripts', () => {
    expect(MINI_APP_SANDBOX_ATTRIBUTE).toBe('allow-scripts');
  });
});

describe('MINI_APP_BASE_CSP_DIRECTIVES', () => {
  it('contains no "self" source anywhere', () => {
    for (const value of Object.values(MINI_APP_BASE_CSP_DIRECTIVES)) {
      expect(value).not.toContain("'self'");
    }
  });

  it('contains no wildcard, https:, or unsafe-* source', () => {
    for (const value of Object.values(MINI_APP_BASE_CSP_DIRECTIVES)) {
      expect(value).not.toContain('*');
      expect(value).not.toContain('https:');
      expect(value.toLowerCase()).not.toContain('unsafe-inline');
      expect(value.toLowerCase()).not.toContain('unsafe-eval');
    }
  });

  it('denies connect-src, frame-src, and object-src by default', () => {
    expect(MINI_APP_BASE_CSP_DIRECTIVES['connect-src']).toBe("'none'");
    expect(MINI_APP_BASE_CSP_DIRECTIVES['frame-src']).toBe("'none'");
    expect(MINI_APP_BASE_CSP_DIRECTIVES['object-src']).toBe("'none'");
  });

  it('includes worker-src and script-src-attr hardening directives', () => {
    expect(MINI_APP_BASE_CSP_DIRECTIVES['worker-src']).toBe("'none'");
    expect(MINI_APP_BASE_CSP_DIRECTIVES['script-src-attr']).toBe("'none'");
  });

  it('does not itself define script-src', () => {
    expect(MINI_APP_BASE_CSP_DIRECTIVES['script-src']).toBeUndefined();
  });
});

describe('buildMiniAppCsp', () => {
  const hash = 'sha256-abcDEF123+/=';

  it('produces a script-src hash source, wrapped in quotes', () => {
    const csp = buildMiniAppCsp(hash);
    expect(csp).toContain(`script-src '${hash}'`);
  });

  it('never emits "self" anywhere in the built policy', () => {
    const csp = buildMiniAppCsp(hash);
    expect(csp).not.toContain("'self'");
  });

  it('includes every base directive', () => {
    const csp = buildMiniAppCsp(hash);
    for (const name of Object.keys(MINI_APP_BASE_CSP_DIRECTIVES)) {
      expect(csp).toContain(name);
    }
  });

  it.each(["'unsafe-inline'", "'unsafe-eval'", "sha256-abc 'self'", 'https://example.com'])(
    'rejects an unsafe/malformed script-src source: %s',
    (value) => {
      expect(() => buildMiniAppCsp(value)).toThrow();
    },
  );

  it('rejects a wildcard script-src', () => {
    expect(() => buildMiniAppCsp('*')).toThrow();
  });
});
