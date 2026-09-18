import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePackage } from './validate.js';
import { InitError, initProject, type InitResult } from './init.js';

const created: string[] = [];

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-init-'));
  created.push(dir);
  return dir;
}

async function scaffold(id = 'com.example.hello'): Promise<string> {
  const dir = await tempDir();
  await initProject({ projectDir: dir, id });
  return dir;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('initProject', () => {
  it('writes the four scaffold files', async () => {
    const dir = await scaffold();
    const result = await readFile(join(dir, 'openmini.json'), 'utf8');

    expect(JSON.parse(result)).toMatchObject({ id: 'com.example.hello', entry: 'index.html' });
    await expect(readFile(join(dir, 'package.json'), 'utf8')).resolves.toContain('@openmini/sdk');
    await expect(readFile(join(dir, 'src', 'index.html'), 'utf8')).resolves.toContain('<script>');
    await expect(readFile(join(dir, 'src', 'main.ts'), 'utf8')).resolves.toContain(
      'connectOpenMini',
    );
  });

  // R4 (Phase 8.5). `connectOpenMini` can now reject with HANDSHAKE_TIMEOUT
  // instead of hanging, which is only an improvement if new apps handle it —
  // otherwise every scaffolded app trades a silent hang for an unhandled
  // rejection, which is not obviously better for the author.
  //
  // This is a structural assertion on generated source, which is weaker than
  // executing it; the scaffold is compiled and run end-to-end by the CLI
  // binary and e2e coverage, and this check is what pins the specific
  // property those tests do not isolate.
  it('scaffolds an entry script that handles the handshake rejection', async () => {
    const dir = await scaffold();
    const main = await readFile(join(dir, 'src', 'main.ts'), 'utf8');

    const connectLine = main.indexOf('await connectOpenMini()');
    const tryLine = main.indexOf('try {');
    const catchLine = main.indexOf('} catch (error) {');

    expect(tryLine).toBeGreaterThan(-1);
    expect(connectLine).toBeGreaterThan(tryLine);
    expect(catchLine).toBeGreaterThan(connectLine);
    // The catch must actually report something, not swallow the failure.
    expect(main.slice(catchLine)).toMatch(/status\.textContent\s*=/);
  });

  // R5 (Phase 8.5). `init` never validated `--id`, so it cheerfully produced
  // projects that `openmini validate` then rejected — two commands in the
  // same binary disagreeing about what a valid manifest is.
  describe('produces only manifests validate accepts', () => {
    it.each(['NOPE', 'com..example', 'com.example.', '9lives.app', '', 'com example'])(
      'rejects the invalid id %j and writes nothing',
      async (id) => {
        const dir = await tempDir();

        await expect(initProject({ projectDir: dir, id })).rejects.toThrow(InitError);
        expect(await readdir(dir)).toEqual([]);
      },
    );

    it('feeds its own output straight to validatePackage, which accepts it', async () => {
      const dir = await scaffold('com.example.ok');
      await expect(validatePackage(dir)).resolves.toMatchObject({ ok: true });
    });
  });

  // R5, second half: the scaffold used to be four sequential writes with no
  // existence check, so a conflict on the *last* file left the first three
  // already overwritten — and `openmini.json` and `package.json` are exactly
  // the two a user is most likely to have authored themselves.
  describe('without --force, a conflict leaves the filesystem unchanged', () => {
    it('refuses when only the last-written file exists, and writes none of the others', async () => {
      const dir = await tempDir();
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'src', 'main.ts'), 'MINE', 'utf8');

      await expect(initProject({ projectDir: dir, id: 'com.example.ok' })).rejects.toThrow(
        InitError,
      );

      expect(await exists(join(dir, 'openmini.json'))).toBe(false);
      expect(await exists(join(dir, 'package.json'))).toBe(false);
      expect(await exists(join(dir, 'src', 'index.html'))).toBe(false);
      expect(await readFile(join(dir, 'src', 'main.ts'), 'utf8')).toBe('MINE');
    });

    it('does not create src/ as a side effect of a refused run', async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'openmini.json'), 'MINE', 'utf8');

      await expect(initProject({ projectDir: dir, id: 'com.example.ok' })).rejects.toThrow(
        InitError,
      );

      expect(await readdir(dir)).toEqual(['openmini.json']);
      expect(await readFile(join(dir, 'openmini.json'), 'utf8')).toBe('MINE');
    });

    it('reports every conflict at once rather than one run at a time', async () => {
      const dir = await tempDir();
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'openmini.json'), 'MINE', 'utf8');
      await writeFile(join(dir, 'src', 'main.ts'), 'MINE', 'utf8');

      const outcome: InitResult | Error = await initProject({
        projectDir: dir,
        id: 'com.example.ok',
      }).catch((e: unknown) => e as Error);

      expect(outcome).toBeInstanceOf(InitError);
      const { message } = outcome as Error;
      expect(message).toContain('openmini.json');
      expect(message).toContain('src/main.ts');
      expect(message).not.toContain('package.json');
    });

    it('--force overwrites all four destinations', async () => {
      const dir = await tempDir();
      await mkdir(join(dir, 'src'), { recursive: true });
      await writeFile(join(dir, 'openmini.json'), 'MINE', 'utf8');
      await writeFile(join(dir, 'package.json'), 'MINE', 'utf8');
      await writeFile(join(dir, 'src', 'index.html'), 'MINE', 'utf8');
      await writeFile(join(dir, 'src', 'main.ts'), 'MINE', 'utf8');

      await initProject({ projectDir: dir, id: 'com.example.ok', force: true });

      for (const file of ['openmini.json', 'package.json', 'src/index.html', 'src/main.ts']) {
        await expect(readFile(join(dir, ...file.split('/')), 'utf8')).resolves.not.toBe('MINE');
      }
    });

    it('validates the id before the conflict preflight, so a bad id writes nothing either', async () => {
      const dir = await tempDir();
      await writeFile(join(dir, 'openmini.json'), 'MINE', 'utf8');

      await expect(initProject({ projectDir: dir, id: 'NOPE', force: true })).rejects.toThrow(
        InitError,
      );
      expect(await readFile(join(dir, 'openmini.json'), 'utf8')).toBe('MINE');
    });
  });
});
