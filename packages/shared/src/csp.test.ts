import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

describe('buildMiniAppCsp style-src hashes', () => {
  const scriptHash = 'sha256-abcDEF123+/=';
  const styleHash = 'sha256-styleHASH456+/=';

  it('leaves style-src as none when no style hash is supplied', () => {
    expect(buildMiniAppCsp(scriptHash)).toContain("style-src 'none'");
  });

  it('widens style-src to the supplied hash source', () => {
    const csp = buildMiniAppCsp(scriptHash, [styleHash]);
    expect(csp).toContain(`style-src '${styleHash}'`);
    expect(csp).not.toContain("style-src 'none'");
  });

  it('supports multiple style hash sources, space separated', () => {
    const second = 'sha256-secondSTYLE789+/=';
    expect(buildMiniAppCsp(scriptHash, [styleHash, second])).toContain(
      `style-src '${styleHash}' '${second}'`,
    );
  });

  it('keeps script-src intact when style hashes are supplied', () => {
    expect(buildMiniAppCsp(scriptHash, [styleHash])).toContain(`script-src '${scriptHash}'`);
  });

  it.each(["'unsafe-inline'", "'unsafe-eval'", "sha256-abc 'self'", 'https://example.com', '*'])(
    'holds style-src to the same standard as script-src, rejecting: %s',
    (value) => {
      expect(() => buildMiniAppCsp(scriptHash, [value])).toThrow();
    },
  );

  it('never emits unsafe-hashes, so style attributes stay blocked', () => {
    expect(buildMiniAppCsp(scriptHash, [styleHash])).not.toContain('unsafe-hashes');
  });

  it('leaves script-src-attr at none, so inline event handlers stay blocked', () => {
    expect(buildMiniAppCsp(scriptHash, [styleHash])).toContain("script-src-attr 'none'");
  });
});

describe('single source of truth', () => {
  /**
   * The runtime enforces this policy and the CLI generates packages against
   * it. When those were separate copies, the duplicate carried a "keep this
   * list in sync by hand" comment — exactly the drift hazard this guards
   * against. There must be one definition, here.
   */
  const repoRoot = fileURLToPath(new URL('../../..', import.meta.url));

  function sourceFiles(dir: string, found: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (
        ['node_modules', 'dist', '.git', 'generated', 'test-results', 'playwright-report'].includes(
          entry.name,
        )
      ) {
        continue;
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        sourceFiles(full, found);
      } else if (/\.(ts|tsx|mjs|js)$/.test(entry.name) && !entry.name.includes('.test.')) {
        found.push(full);
      }
    }
    return found;
  }

  it('defines the directive constant exactly once in the repository', () => {
    const definitions = sourceFiles(repoRoot).filter((file) =>
      readFileSync(file, 'utf8').includes('export const MINI_APP_BASE_CSP_DIRECTIVES'),
    );

    expect(definitions.map((file) => file.replace(repoRoot, '').replace(/\\/g, '/'))).toEqual([
      'packages/shared/src/csp.ts',
    ]);
  });

  it('has no second hand-written copy of the directive list', () => {
    // A copy would have to spell out the directives; this one is distinctive
    // enough not to appear incidentally.
    const copies = sourceFiles(repoRoot).filter(
      (file) =>
        readFileSync(file, 'utf8').includes(`'form-action': "'none'"`) &&
        !file.endsWith(join('shared', 'src', 'csp.ts')),
    );

    expect(copies.map((file) => file.replace(repoRoot, ''))).toEqual([]);
  });
});
