import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run } from './run.js';

let logs: string[] = [];
let errors: string[] = [];

beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args) => {
    logs.push(args.join(' '));
  });
  vi.spyOn(console, 'error').mockImplementation((...args) => {
    errors.push(args.join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

describe('exit codes', () => {
  it('exits 0 for --version', async () => {
    expect(await run(['--version'])).toBe(0);
    expect(logs.join('\n')).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('exits 0 for an explicit help request', async () => {
    expect(await run(['help'])).toBe(0);
  });

  it('exits non-zero when invoked with no command', async () => {
    expect(await run([])).toBe(1);
  });

  it('exits non-zero for an unknown command', async () => {
    expect(await run(['frobnicate'])).toBe(1);
    expect(errors.join('\n')).toContain('unknown command');
  });

  it('exits non-zero when init is missing --id', async () => {
    expect(await run(['init', await tempDir('openmini-run-')])).toBe(1);
    expect(errors.join('\n')).toContain('--id');
  });
});

describe('validate command', () => {
  it('exits 0 and reports the app for a valid manifest', async () => {
    const dir = await tempDir('openmini-run-');
    await run(['init', dir, '--id', 'com.example.ok']);
    logs = [];

    expect(await run(['validate', dir])).toBe(0);
    expect(logs.join('\n')).toContain('com.example.ok');
  });

  it('exits non-zero and formats issues for an invalid manifest', async () => {
    const dir = await tempDir('openmini-run-');
    await writeFile(join(dir, 'openmini.json'), '{"schemaVersion":1,"id":"nope"}', 'utf8');

    expect(await run(['validate', dir])).toBe(1);
    expect(errors.join('\n')).toContain('Invalid OpenMini manifest');
  });

  it('exits non-zero when there is no manifest to read', async () => {
    expect(await run(['validate', await tempDir('openmini-run-')])).toBe(1);
    expect(errors.join('\n')).toContain('cannot read manifest');
  });
});

describe('init command', () => {
  it('scaffolds a project whose manifest validates', async () => {
    const dir = await tempDir('openmini-run-');
    expect(await run(['init', dir, '--id', 'com.example.scaffold'])).toBe(0);

    expect((await readdir(dir)).sort()).toEqual(['openmini.json', 'package.json', 'src']);
    expect(await run(['validate', dir])).toBe(0);
  });

  it('scaffolds a document the build pipeline accepts', async () => {
    const dir = await tempDir('openmini-run-');
    await run(['init', dir, '--id', 'com.example.scaffold']);

    const html = await readFile(join(dir, 'src', 'index.html'), 'utf8');
    // The scaffold must obey the constraints the builder enforces, or the
    // very first build after `init` would fail.
    expect(html).toContain('<script></script>');
    expect(html).not.toContain('Content-Security-Policy');
    expect(html).not.toMatch(/\son[a-z]+\s*=/);
    expect(html).not.toMatch(/\sstyle\s*=/);
    expect(html).toContain('<style>');
  });

  it('uses the id as the name when none is given', async () => {
    const dir = await tempDir('openmini-run-');
    await run(['init', dir, '--id', 'com.example.widget']);

    const manifest = JSON.parse(await readFile(join(dir, 'openmini.json'), 'utf8')) as { name: string };
    expect(manifest.name).toBe('widget');
  });
});

describe('build command', () => {
  it('exits non-zero when the project is invalid', async () => {
    const dir = await tempDir('openmini-run-');
    await writeFile(join(dir, 'openmini.json'), '{"schemaVersion":1,"id":"nope"}', 'utf8');

    await expect(run(['build', dir, '--out', join(dir, 'out')])).rejects.toThrow();
  });

  it('rejects a flag with no value', async () => {
    await expect(run(['build', '.', '--out'])).rejects.toThrow(/requires a value/);
  });
});
