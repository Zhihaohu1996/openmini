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

// R8 (Phase 8.5). `run`'s docstring promised these exit codes; three of the
// four commands did not deliver them, relying on cli.ts's last-resort catch
// instead. These pin the contract at the level that claims it.
describe('command-line contract', () => {
  it('honours --version only as the first token', async () => {
    const dir = await tempDir('openmini-run-');
    // `argv.includes('-v')` used to match this flag *value*, print the
    // version and exit 0 — scaffolding nothing while reporting success.
    expect(await run(['init', dir, '--id', 'com.example.ok', '--name', '-v'])).toBe(0);

    expect(logs.join('\n')).not.toMatch(/^\d+\.\d+\.\d+$/m);
    expect((await readdir(dir)).sort()).toEqual(['openmini.json', 'package.json', 'src']);
  });

  it.each(['build', 'init', 'validate', 'dev'])(
    'prints usage for %s --help and exits 0',
    async (command) => {
      // `build --help` used to throw "flag --help requires a value", because
      // --help was parsed as a flag expecting a value like any other.
      expect(await run([command, '--help'])).toBe(0);
      expect(logs.join('\n')).toContain(`openmini ${command}`);
    },
  );

  it('accepts the -h alias', async () => {
    expect(await run(['build', '-h'])).toBe(0);
  });

  it.each([
    ['build', '--ouput'],
    ['init', '--forse'],
    ['dev', '--host'],
    ['validate', '--strict'],
  ])('rejects the unknown flag %s %s', async (command, flag) => {
    expect(await run([command, flag, 'x'])).toBe(1);
    expect(errors.join('\n')).toContain('unknown flag');
  });

  it.each(['abc', '0', '65536', '80.5', '-1', ''])('rejects --port %j', async (value) => {
    expect(await run(['dev', '--port', value])).toBe(1);
    expect(errors.join('\n')).toContain('--port must be an integer');
  });

  it('returns 1 from run() itself when a flag has no value', async () => {
    expect(await run(['build', '.', '--out'])).toBe(1);
    expect(errors.join('\n')).toContain('requires a value');
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

    const manifest = JSON.parse(await readFile(join(dir, 'openmini.json'), 'utf8')) as {
      name: string;
    };
    expect(manifest.name).toBe('widget');
  });
});

describe('build command', () => {
  it('returns 1 from run() when the project is invalid, rather than throwing', async () => {
    const dir = await tempDir('openmini-run-');
    await writeFile(join(dir, 'openmini.json'), '{"schemaVersion":1,"id":"nope"}', 'utf8');

    // Previously this propagated a PackageBuildError out of `run`, so the
    // non-zero exit came from cli.ts's catch-all rather than from the exit
    // code `run` documents itself as returning.
    expect(await run(['build', dir, '--out', 'out'])).toBe(1);
    expect(errors.join('\n')).toContain('Invalid OpenMini manifest');
  });

  it('returns 1 and reports the reason for an --out outside the project', async () => {
    const dir = await tempDir('openmini-run-');
    await run(['init', dir, '--id', 'com.example.ok']);
    errors = [];

    expect(await run(['build', dir, '--out', '../escape'])).toBe(1);
    expect(errors.join('\n')).toContain('--out must be a directory inside the project');
  });
});
