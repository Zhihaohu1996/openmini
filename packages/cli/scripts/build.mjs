#!/usr/bin/env node
/**
 * Builds the CLI.
 *
 * Unlike the other packages — which are consumed by a bundler that resolves
 * their TypeScript sources directly — this one ships an executable that runs
 * in plain Node. So the workspace dependencies must be bundled in rather than
 * left as bare `@openmini/*` specifiers pointing at `.ts` files Node cannot
 * load. `esbuild` itself stays external: it has platform-specific binaries
 * and must be resolved from node_modules at runtime.
 *
 * Declarations still come from `tsc --emitDeclarationOnly`, so the package
 * remains type-checked by the same compiler settings as everything else.
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..');

await build({
  entryPoints: [join(packageDir, 'src', 'cli.ts'), join(packageDir, 'src', 'index.ts')],
  outdir: join(packageDir, 'dist'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  external: ['esbuild'],
  // No shebang banner here: cli.ts already carries one and esbuild preserves
  // it, while index.ts is a library entry that must not have one.
  logLevel: 'warning',
});

// Resolved through node rather than a shell so there is no platform-specific
// quoting and no dependency on PATH.
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
execFileSync(
  process.execPath,
  [tsc, '-p', join(packageDir, 'tsconfig.json'), '--emitDeclarationOnly'],
  {
    stdio: 'inherit',
  },
);
