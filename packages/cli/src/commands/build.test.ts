import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
