import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Executes the built binary, as a user would.
 *
 * Everything else in this package tests `run()` in-process, which cannot
 * observe the things that only exist once the code is built and spawned: that
 * `dist/cli.js` is emitted at all, that it is valid ESM under a real Node,
 * that the shebang and `bin` wiring work, and that `cli.ts`'s
 * `process.exitCode` assignment reaches the shell. A CLI whose exit codes are
 * right in a unit test and wrong in a terminal is still broken, and CI
 * depends on those codes.
 */
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runCli(args: string[], cwd?: string): RunResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd,
  });
  return {
    status: result.status ?? -1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

const MANIFEST = `{
  "schemaVersion": 1,
  "id": "com.example.binary",
  "name": "Binary",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": []
}
`;

const HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Binary</title>
<style>body { color: rebeccapurple; }</style>
</head><body><h1 id="t">hi</h1><script></script></body></html>
`;

// No imports: the binary test must not depend on @openmini/sdk being
// resolvable from a directory outside the workspace.
const SCRIPT = `const el = document.getElementById('t');
if (el) {
  el.textContent = 'built';
}
`;

async function makeProject(options: { manifest?: string } = {}): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-bin-'));
  await mkdir(join(dir, 'src'), { recursive: true });
  await writeFile(join(dir, 'openmini.json'), options.manifest ?? MANIFEST, 'utf8');
  await writeFile(join(dir, 'src', 'index.html'), HTML, 'utf8');
  await writeFile(join(dir, 'src', 'main.ts'), SCRIPT, 'utf8');
  return dir;
}

beforeAll(() => {
  if (!existsSync(CLI)) {
    throw new Error(
      `the CLI binary is not built: ${CLI} does not exist.\n` +
        'Run `pnpm build` (or `pnpm --filter @openmini/cli build`) before this suite. ' +
        'CI runs build before test for exactly this reason.',
    );
  }
});

describe('the built binary', () => {
  it('prints the version and exits 0', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('prints usage and exits 0 for --help', () => {
    const result = runCli(['--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits 1 with usage when given no arguments', () => {
    const result = runCli([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Usage:');
  });

  it('exits 1 for an unknown command', () => {
    const result = runCli(['frobnicate']);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('unknown command');
  });

  it('exits 1 and reports on stderr for an invalid manifest', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'openmini-bin-'));
    await writeFile(join(dir, 'openmini.json'), '{"schemaVersion":1,"id":"nope"}', 'utf8');

    const result = runCli(['validate', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid OpenMini manifest');
  });

  it('exits 0 for a valid manifest', async () => {
    const dir = await makeProject();
    const result = runCli(['validate', dir]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('com.example.binary');
  });

  it('exits 1 when building a broken project', async () => {
    const dir = await makeProject({ manifest: '{"schemaVersion":1,"id":"nope"}' });

    const result = runCli(['build', dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Invalid OpenMini manifest');
  });

  it('exits 0 building a good project and writes exactly the two files', async () => {
    const dir = await makeProject();

    const result = runCli(['build', dir]);
    expect(result.status).toBe(0);
    expect((await readdir(join(dir, 'dist'))).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it('writes the default output inside the project, not the working directory', async () => {
    const dir = await makeProject();
    // Spawned from somewhere else entirely: before R7, `--out`'s default
    // resolved against this cwd and the package landed here instead.
    const elsewhere = await mkdtemp(join(tmpdir(), 'openmini-cwd-'));

    expect(runCli(['build', dir], elsewhere).status).toBe(0);
    expect(await readdir(elsewhere)).toEqual([]);
    expect((await readdir(join(dir, 'dist'))).sort()).toEqual(['index.html', 'openmini.json']);
  });

  it('exits 1 for an --out that escapes the project', async () => {
    const dir = await makeProject();
    const result = runCli(['build', dir, '--out', '../escape']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('--out must be a directory inside the project');
  });

  it('exits 0 for a per-command help request', () => {
    const result = runCli(['build', '--help']);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('openmini build');
  });
});
