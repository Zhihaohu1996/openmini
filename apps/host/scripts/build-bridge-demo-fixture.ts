#!/usr/bin/env node
/**
 * Builds the bridge-demo fixture document from its real @openmini/sdk-based
 * Mini App source.
 *
 * This used to hand-roll the packaging: bundle, sha256, and a *copied* list
 * of the runtime's CSP directives carrying a "keep this in sync by hand"
 * comment. It now goes through @openmini/cli's `assembleEntryDocument`, the
 * same code path a real Mini App author uses, so there is exactly one
 * definition of the packaging contract and this fixture proves the CLI
 * produces documents the real runtime accepts — every sandbox/bridge e2e
 * spec runs against this output.
 *
 * Run via tsx (see package.json's build:fixtures) because it imports
 * TypeScript workspace packages directly.
 */
import { assembleEntryDocument } from '@openmini/cli';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(scriptDir, '..', 'src', 'miniapp', 'fixtures', 'bridge-demo');
const outDir = join(fixtureDir, 'generated');

/**
 * The fixture's HTML shell. The elements here are the hooks the e2e specs
 * assert against; the empty <script> is the placeholder the bundled Mini App
 * code is inlined into, and there is deliberately no CSP meta — the builder
 * owns that.
 */
const SHELL = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>bridge-demo</title>
</head>
<body>
<h1>Bridge demo</h1>
<p id="storage-result">pending...</p>
<p id="user-result">pending...</p>
<p id="close-result">pending...</p>
<p id="network-result">pending...</p>
<script></script>
</body>
</html>
`;

/**
 * A second, deliberately *styled* package, written out as a real two-file
 * Mini App package under public/miniapps. The styled-package e2e loads it by
 * URL and asserts the browser actually applies the CSS — which only happens
 * if the style hash the builder computed matches, so this is the end-to-end
 * proof of Phase 8's inline-style support.
 */
const STYLED_SHELL = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>hello-styled</title>
<style>
#styled-heading { color: rgb(16, 128, 64); }
</style>
</head>
<body>
<h1 id="styled-heading">styled</h1>
<script></script>
</body>
</html>
`;

const STYLED_MANIFEST = `${JSON.stringify(
  {
    schemaVersion: 1,
    id: 'com.openmini.hello-styled',
    name: 'Hello Styled',
    version: '0.1.0',
    entry: 'index.html',
    permissions: [],
  },
  null,
  2,
)}\n`;

async function bundleScript(entry: string, workingDir: string): Promise<string> {
  const result = await build({
    entryPoints: [entry],
    absWorkingDir: workingDir,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: false,
  });
  const script = result.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error(`esbuild produced no output for ${entry}`);
  }
  return script;
}

async function buildStyledPackage(): Promise<void> {
  const packageDir = join(scriptDir, '..', 'public', 'miniapps', 'hello-styled');
  const script = await bundleScript(join(fixtureDir, 'miniapp-src', 'styled.ts'), fixtureDir);
  const assembled = assembleEntryDocument({ html: STYLED_SHELL, script });

  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'index.html'), assembled.html, 'utf8');
  writeFileSync(join(packageDir, 'openmini.json'), STYLED_MANIFEST, 'utf8');
  console.log(`hello-styled package written to ${packageDir}`);
}

async function main(): Promise<void> {
  const result = await build({
    entryPoints: [join(fixtureDir, 'miniapp-src', 'main.ts')],
    absWorkingDir: fixtureDir,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: false,
  });

  const script = result.outputFiles[0]?.text;
  if (script === undefined) {
    throw new Error('esbuild produced no output for the bridge-demo fixture');
  }

  const assembled = assembleEntryDocument({ html: SHELL, script });

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), assembled.html, 'utf8');
  console.log(`bridge-demo fixture written to ${join(outDir, 'index.html')}`);

  await buildStyledPackage();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
