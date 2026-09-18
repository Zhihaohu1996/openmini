import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The "exactly two files" contract, asserted against the artifact that is
 * actually served and actually loaded by the Phase 8 e2e — not against a
 * temp directory in a unit test.
 *
 * `packageBuild.test.ts` already proves `buildPackage` emits two files into a
 * scratch directory. That is a different claim from "the thing on disk that
 * the browser fetches contains only those two files", which is the one a
 * packaging regression would actually break: an extra sourcemap, a stray
 * `.map`, or a leftover file from a previous build would all pass the unit
 * test and fail here.
 *
 * `apps/host`'s test script runs `build:fixtures` first, so this always reads
 * a freshly built artifact.
 */
const servedDir = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'public',
  'miniapps',
  'hello-styled',
);

describe('the served hello-styled package', () => {
  it('contains exactly the two files the loader reads', async () => {
    expect((await readdir(servedDir)).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it('carries the manifest through byte-for-byte from the authoring project', async () => {
    const authored = join(
      dirname(fileURLToPath(import.meta.url)),
      'hello-styled',
      'openmini.json',
    );

    // `buildPackage` copies the manifest bytes rather than re-serializing, so
    // any drift here means the artifact stopped coming from the real build.
    expect(await readFile(join(servedDir, 'openmini.json'), 'utf8')).toBe(
      await readFile(authored, 'utf8'),
    );
  });

  it('was produced by the builder, carrying exactly one CSP with both hashes', async () => {
    const html = await readFile(join(servedDir, 'index.html'), 'utf8');

    // The CLI owns the policy; a hand-written document would not have these.
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
    expect(html).toMatch(/script-src 'sha256-/);
    expect(html).toMatch(/style-src 'sha256-/);
  });

  it('is written with LF line endings regardless of the build platform', async () => {
    const bytes = await readFile(join(servedDir, 'index.html'));
    expect(bytes.includes('\r'.charCodeAt(0))).toBe(false);
  });
});
