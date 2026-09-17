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

const SCRIPT = `const el = document.getElementById('t');
if (el) {
  el.textContent = 'built';
}
`;

const projects: string[] = [];

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
