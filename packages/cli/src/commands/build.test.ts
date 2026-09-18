import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PackageBuildError } from '../packageBuild.js';
import { buildPackage } from './build.js';

const MANIFEST = `{
  "schemaVersion": 1,
  "id": "com.example.plain",
  "name": "Plain",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": []
}
`;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Plain</title>
<style>body { color: rebeccapurple; }</style>
</head><body><h1 id="t">hi</h1><script></script></body></html>
`;

/**
 * A multi-line `<style>` body. The CRLF hash mismatch (R1) is invisible with a
 * single-line block, because only a body that spans lines contains the CRLF
 * that normalization rewrites.
 */
const MULTI_LINE_STYLE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Plain</title>
<style>
body {
  color: rebeccapurple;
}
</style>
</head><body><h1 id="t">hi</h1><script></script></body></html>
`;

const SCRIPT = `const el = document.getElementById('t');
if (el) {
  el.textContent = 'built';
}
`;

const projects: string[] = [];

function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

function cspOf(document: string): string {
  const match = /<meta http-equiv="Content-Security-Policy" content="([^"]*)">/.exec(document);
  if (!match?.[1]) {
    throw new Error('the built document carries no CSP <meta>');
  }
  return match[1];
}

function directiveOf(csp: string, directive: string): string {
  const found = csp
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${directive} `));
  if (found === undefined) {
    throw new Error(`the CSP has no ${directive} directive: ${csp}`);
  }
  return found.slice(directive.length + 1);
}

function hashSourcesOf(directiveValue: string): string[] {
  return [...directiveValue.matchAll(/'(sha256-[A-Za-z0-9+/=]+)'/g)].map((match) => match[1] ?? '');
}

function bodiesOf(document: string, tag: 'script' | 'style'): string[] {
  const pattern = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  return [...document.matchAll(pattern)].map((match) => match[1] ?? '');
}

/**
 * The invariant: a document's CSP must bind the bytes that document actually
 * carries. Every hash is recomputed from the written text rather than compared
 * against what the builder reported, so this catches R1 and any future variant
 * where hashing and assembly disagree about the content.
 */
function expectCspToBindShippedBytes(document: string): void {
  const csp = cspOf(document);

  const scriptBodies = bodiesOf(document, 'script');
  expect(scriptBodies).toHaveLength(1);
  expect(hashSourcesOf(directiveOf(csp, 'script-src'))).toEqual([
    `sha256-${sha256Base64(scriptBodies[0] ?? '')}`,
  ]);

  const styleBodies = bodiesOf(document, 'style');
  expect(hashSourcesOf(directiveOf(csp, 'style-src'))).toEqual(
    styleBodies.map((body) => `sha256-${sha256Base64(body)}`),
  );
}

async function makeProject(overrides: { manifest?: string; html?: string; script?: string } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-build-'));
  projects.push(dir);
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'openmini.json'), overrides.manifest ?? MANIFEST, 'utf8');
  await writeFile(join(dir, 'src', 'index.html'), overrides.html ?? HTML, 'utf8');
  await writeFile(join(dir, 'src', 'main.ts'), overrides.script ?? SCRIPT, 'utf8');
  return dir;
}

afterEach(() => {
  projects.length = 0;
});

describe('buildPackage output', () => {
  it('emits only the two files the loader consumes', async () => {
    const dir = await makeProject();
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    expect((await readdir(join(dir, 'out'))).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it('names the entry file from the manifest', async () => {
    const dir = await makeProject({
      manifest: MANIFEST.replace('"index.html"', '"app.html"'),
    });
    const result = await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    expect(result.entryFile).toBe('app.html');
    expect((await readdir(join(dir, 'out'))).sort()).toEqual(['app.html', 'openmini.json']);
  });

  it('copies the manifest through byte-for-byte', async () => {
    const dir = await makeProject();
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    const copied = await readFile(join(dir, 'out', 'openmini.json'), 'utf8');
    expect(copied).toBe(MANIFEST);
  });

  it('inlines the bundled script and generates the CSP', async () => {
    const dir = await makeProject();
    const result = await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    const html = await readFile(join(dir, 'out', 'index.html'), 'utf8');
    // esbuild normalizes string quotes, so match on the content only.
    expect(html).toMatch(/textContent = ["']built["']/);
    expect(html).toContain('Content-Security-Policy');
    expect(result.csp).toContain('script-src ');
    expect(result.csp).toContain("style-src 'sha256-");
  });
});

describe('deterministic builds', () => {
  it('produces byte-identical output across repeated builds', async () => {
    const dir = await makeProject();
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out-a') });
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out-b') });

    for (const file of ['index.html', 'openmini.json']) {
      const a = await readFile(join(dir, 'out-a', file));
      const b = await readFile(join(dir, 'out-b', file));
      expect(a.equals(b)).toBe(true);
    }
  });

  it('bakes in no absolute path, timestamp or machine identity', async () => {
    const dir = await makeProject();
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });
    const html = await readFile(join(dir, 'out', 'index.html'), 'utf8');

    // The temp project path is the most likely absolute path to leak.
    expect(html).not.toContain(dir);
    expect(html).not.toContain(tmpdir());
    expect(html).not.toMatch(/[A-Za-z]:\\/);
    expect(html).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
  });

  it('writes LF line endings regardless of the platform it runs on', async () => {
    const dir = await makeProject({ html: HTML.replace(/\n/g, '\r\n') });
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    const html = await readFile(join(dir, 'out', 'index.html'), 'utf8');
    expect(html).not.toContain('\r\n');
  });

  it('changes output only when input changes', async () => {
    const first = await makeProject();
    const second = await makeProject({ script: `${SCRIPT}\nconsole.log('extra');\n` });
    await buildPackage({ projectDir: first, outDir: join(first, 'out') });
    await buildPackage({ projectDir: second, outDir: join(second, 'out') });

    const a = await readFile(join(first, 'out', 'index.html'), 'utf8');
    const b = await readFile(join(second, 'out', 'index.html'), 'utf8');
    expect(a).not.toBe(b);
  });
});

describe('the CSP binds the bytes that ship', () => {
  it('matches the hashes of the written document for LF sources', async () => {
    const dir = await makeProject({ html: MULTI_LINE_STYLE_HTML });
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    expectCspToBindShippedBytes(await readFile(join(dir, 'out', 'index.html'), 'utf8'));
  });

  it('matches when the author’s sources are checked out with CRLF endings', async () => {
    const dir = await makeProject({
      html: MULTI_LINE_STYLE_HTML.replace(/\n/g, '\r\n'),
      script: SCRIPT.replace(/\n/g, '\r\n'),
    });
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    expectCspToBindShippedBytes(await readFile(join(dir, 'out', 'index.html'), 'utf8'));
  });

  it('writes byte-identical output from CRLF and LF sources', async () => {
    const lf = await makeProject({ html: MULTI_LINE_STYLE_HTML });
    const crlf = await makeProject({ html: MULTI_LINE_STYLE_HTML.replace(/\n/g, '\r\n') });
    await buildPackage({ projectDir: lf, outDir: join(lf, 'out') });
    await buildPackage({ projectDir: crlf, outDir: join(crlf, 'out') });

    const fromLf = await readFile(join(lf, 'out', 'index.html'));
    const fromCrlf = await readFile(join(crlf, 'out', 'index.html'));
    expect(fromCrlf.equals(fromLf)).toBe(true);
  });

  it('writes no CR byte anywhere in the document', async () => {
    const dir = await makeProject({ html: MULTI_LINE_STYLE_HTML.replace(/\n/g, '\r\n') });
    await buildPackage({ projectDir: dir, outDir: join(dir, 'out') });

    expect(await readFile(join(dir, 'out', 'index.html'), 'utf8')).not.toContain('\r');
  });
});

/**
 * A drive letter with no volume mounted on it, or null if there is none (or
 * we are not on Windows). Used so the different-drive test names a path that
 * cannot exist, and therefore cannot be destroyed by a regression.
 */
const unusedDriveLetter: string | null =
  process.platform === 'win32'
    ? (['Q', 'R', 'V', 'W', 'X', 'Y', 'Z'].find((letter) => !existsSync(`${letter}:\\`)) ?? null)
    : null;

// R7 (Phase 8.5). `--out` resolved against the *current working directory*
// while docs/cli.md described it as project-relative, and `buildPackage`
// `rm -rf`s its output directory with no containment check at all. Together
// that meant `openmini build ./proj --out .` deleted whatever directory the
// shell happened to be in — for the documented usage, the project's own
// source tree.
describe('--out containment', () => {
  // These tests feed `buildPackage` the exact inputs that used to make it
  // delete the wrong directory, and `buildPackage` deletes its output
  // directory for real. Against the *fixed* code that is safe, because
  // rejection happens before the `rm`. Against a regression it is not: the
  // pre-fix code resolved `--out ..` against `process.cwd()`, so running this
  // suite from `packages/cli` deleted `packages/`. That is not hypothetical —
  // it happened once while this fix was being verified.
  //
  // So the working directory is moved into a throwaway tree for the duration,
  // and — this is the part that is easy to get wrong — it is moved *deep
  // enough inside it*. Sitting directly in a `mkdtemp` directory is not
  // enough: that directory's parent is the OS temp root, so a regression
  // meeting `--out ..` would `rm -rf` the whole of it, taking every other
  // process's temp files with it. Nesting a few levels down means the
  // furthest any input here can climb is still inside the disposable root.
  //
  // The assertions are identical either way; only the blast radius of a
  // regression changes. (Vitest isolates each test file in its own process,
  // so the chdir cannot leak into another suite.)
  const originalCwd = process.cwd();

  beforeEach(async () => {
    const root = await mkdtemp(join(tmpdir(), 'openmini-cwd-'));
    projects.push(root);
    const nested = join(root, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });
    process.chdir(nested);
  });

  afterEach(() => {
    process.chdir(originalCwd);
  });

  it('resolves a relative --out against the project, not the process CWD', async () => {
    const dir = await makeProject();
    const result = await buildPackage({ projectDir: dir, outDir: 'dist' });

    expect(result.outDir).toBe(join(dir, 'dist'));
    expect((await readdir(join(dir, 'dist'))).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it.each([
    ['the project root itself', '.'],
    ['a parent directory', '../outside'],
    ['the immediate parent', '..'],
    ['a path that climbs back out', 'dist/../../outside'],
  ])('rejects %s (--out %j)', async (_label, outDir) => {
    const dir = await makeProject();

    await expect(buildPackage({ projectDir: dir, outDir })).rejects.toThrow(PackageBuildError);
    // Rejected before any deletion: the project's own files are still here.
    expect((await readdir(dir)).sort()).toEqual(['openmini.json', 'src']);
    expect((await readdir(join(dir, 'src'))).sort()).toEqual(['index.html', 'main.ts']);
  });

  it('rejects an absolute path outside the project, leaving that path untouched', async () => {
    const dir = await makeProject();
    const outsider = await mkdtemp(join(tmpdir(), 'openmini-outsider-'));
    projects.push(outsider);
    await writeFile(join(outsider, 'precious.txt'), 'keep me', 'utf8');

    await expect(buildPackage({ projectDir: dir, outDir: outsider })).rejects.toThrow(
      PackageBuildError,
    );
    await expect(readFile(join(outsider, 'precious.txt'), 'utf8')).resolves.toBe('keep me');
  });

  it('rejects an ancestor of the project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'openmini-parent-'));
    projects.push(parent);
    const dir = join(parent, 'proj');
    await mkdir(join(dir, 'src'), { recursive: true });
    await writeFile(join(dir, 'openmini.json'), MANIFEST, 'utf8');
    await writeFile(join(dir, 'src', 'index.html'), HTML, 'utf8');
    await writeFile(join(dir, 'src', 'main.ts'), SCRIPT, 'utf8');
    await writeFile(join(parent, 'sibling.txt'), 'keep me', 'utf8');

    await expect(buildPackage({ projectDir: dir, outDir: parent })).rejects.toThrow(
      PackageBuildError,
    );
    await expect(readFile(join(parent, 'sibling.txt'), 'utf8')).resolves.toBe('keep me');
  });

  // Deliberately an *unmounted* drive letter, not simply a different one: a
  // regression here would `rm -rf` this path for real, and picking, say, D:\
  // could destroy a developer's second disk. On a volume that does not exist,
  // `rm(..., { force: true })` is a no-op. Skipped if every letter is in use.
  it.runIf(unusedDriveLetter !== null)(
    'rejects an absolute path on a different drive',
    async () => {
      const dir = await makeProject();
      // `path.relative` returns an absolute path when no relative route
      // exists between two drives, which is the case this catches.
      const outDir = `${unusedDriveLetter as string}:\\out`;

      await expect(buildPackage({ projectDir: dir, outDir })).rejects.toThrow(PackageBuildError);
    },
  );

  it('accepts a nested descendant, and a name that merely starts with dots', async () => {
    const dir = await makeProject();

    await expect(buildPackage({ projectDir: dir, outDir: 'build/pkg' })).resolves.toMatchObject({
      outDir: join(dir, 'build', 'pkg'),
    });
    // `..cache` is a legitimate descendant; a bare `startsWith('..')` test
    // would reject it along with genuine ancestors.
    await expect(buildPackage({ projectDir: dir, outDir: '..cache' })).resolves.toMatchObject({
      outDir: join(dir, '..cache'),
    });
  });
});

describe('build failures', () => {
  it('rejects an invalid manifest with the shared formatter output', async () => {
    const dir = await makeProject({ manifest: '{ "schemaVersion": 1, "id": "nope" }' });
    await expect(buildPackage({ projectDir: dir, outDir: join(dir, 'out') })).rejects.toThrow(
      /Invalid OpenMini manifest/,
    );
  });

  it('rejects malformed manifest JSON', async () => {
    const dir = await makeProject({ manifest: '{ not json' });
    await expect(buildPackage({ projectDir: dir, outDir: join(dir, 'out') })).rejects.toThrow(
      PackageBuildError,
    );
  });

  it('propagates an unsupported construct from the document assembler', async () => {
    const dir = await makeProject({ html: HTML.replace('<h1 id="t">hi</h1>', '<img src="x.png">') });
    await expect(buildPackage({ projectDir: dir, outDir: join(dir, 'out') })).rejects.toThrow(
      /<img> element/,
    );
  });

  it('fails when the entry script cannot be bundled', async () => {
    // The import must be *used*: esbuild elides unused TypeScript imports as
    // possible type-only imports, so an unused bad specifier resolves fine.
    const dir = await makeProject({
      script: "import { x } from './does-not-exist';\nconsole.log(x);\n",
    });
    await expect(buildPackage({ projectDir: dir, outDir: join(dir, 'out') })).rejects.toThrow(
      /does-not-exist/,
    );
  });
});
