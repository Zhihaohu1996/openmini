#!/usr/bin/env node
/**
 * Bundles the bridge-demo fixture's real @openmini/sdk-based Mini App
 * source (miniapp-src/main.ts) into a single IIFE via esbuild, computes
 * its sha256 hash, and writes a static fixture document embedding both —
 * this is a Node-only step (esbuild's build() API isn't browser-runnable),
 * unlike hello-sandbox's fixture, which computes its CSP hash client-side
 * from a literal script string. Run before dev/build/test (see
 * package.json's build:fixtures script) so the generated file always
 * exists when the host app or its tests import it.
 */
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(__dirname, '..', 'src', 'miniapp', 'fixtures', 'bridge-demo');
const outDir = join(fixtureDir, 'generated');

/**
 * Mirrors @openmini/runtime's sandbox/csp.ts MINI_APP_BASE_CSP_DIRECTIVES —
 * duplicated here (not imported) because this script runs as plain Node,
 * outside the Vite/TS graph. The same cross-boundary constraint already
 * forces every sandboxed fixture's own bootstrap script to duplicate
 * small pieces of runtime logic it cannot import; keep this list in sync
 * with csp.ts by hand if that module's directives ever change.
 */
const BASE_CSP_DIRECTIVES = {
  'default-src': "'none'",
  'style-src': "'none'",
  'img-src': "'none'",
  'font-src': "'none'",
  'connect-src': "'none'",
  'frame-src': "'none'",
  'object-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
  'worker-src': "'none'",
  'script-src-attr': "'none'",
};

function buildCsp(scriptHashBase64) {
  const directives = {
    'default-src': BASE_CSP_DIRECTIVES['default-src'],
    'script-src': `'sha256-${scriptHashBase64}'`,
    ...BASE_CSP_DIRECTIVES,
  };
  directives['script-src'] = `'sha256-${scriptHashBase64}'`;
  return Object.entries(directives)
    .map(([name, value]) => `${name} ${value}`)
    .join('; ');
}

async function main() {
  const result = await build({
    entryPoints: [join(fixtureDir, 'miniapp-src', 'main.ts')],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
  });

  const script = result.outputFiles[0].text;
  const hash = createHash('sha256').update(script, 'utf8').digest('base64');
  const csp = buildCsp(hash);

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>bridge-demo</title>
</head>
<body>
<h1>Bridge demo</h1>
<p id="storage-result">pending...</p>
<p id="user-result">pending...</p>
<p id="close-result">pending...</p>
<script>${script}</script>
</body>
</html>
`;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'index.html'), html, 'utf8');
  console.log(`bridge-demo fixture written to ${join(outDir, 'index.html')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
