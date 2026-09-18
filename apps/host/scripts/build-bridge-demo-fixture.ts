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
import { assembleEntryDocument, buildPackage } from '@openmini/cli';
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
 * The styled package the Phase 8 e2e loads by URL.
 *
 * This used to hand-roll the packaging here — its own esbuild config (missing
 * `legalComments: 'none'`), a direct `assembleEntryDocument` call, and two
 * hand-written files — which meant the e2e claiming to prove "a package built
 * by @openmini/cli" never called `buildPackage` and so exercised neither
 * manifest validation, nor entry-name derivation, nor the output `rm`, nor
 * line-ending normalization.
 *
 * It is now a real authoring project (`fixtures/hello-styled/`) built by
 * `buildPackage`, so the artifact the e2e runs against comes from the
 * production path.
 *
 * The copy step exists because `--out` must resolve to a strict descendant of
 * the project (Phase 8.5 R7 — `buildPackage` deletes that directory, so it may
 * not point anywhere else). The package is therefore built inside the project
 * and the two files it emits are copied to the served location. Copying the
 * two files by name, rather than the directory, keeps the "exactly two files"
 * contract true by construction.
 */
async function buildStyledPackage(): Promise<void> {
  const projectDir = join(scriptDir, '..', 'src', 'miniapp', 'fixtures', 'hello-styled');
  const servedDir = join(scriptDir, '..', 'public', 'miniapps', 'hello-styled');

  // The entry keeps its `styled.ts` name rather than the default `src/main.ts`,
  // which also means this exercises the `--script` override.
  const result = await buildPackage({
    projectDir,
    outDir: 'dist',
    scriptPath: 'src/styled.ts',
  });

  rmSync(servedDir, { recursive: true, force: true });
  mkdirSync(servedDir, { recursive: true });
  for (const file of [result.manifestFile, result.entryFile]) {
    copyFileSync(join(result.outDir, file), join(servedDir, file));
  }

  console.log(`hello-styled package built by buildPackage and served from ${servedDir}`);
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
