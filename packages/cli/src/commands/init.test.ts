import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initProject } from './init.js';

const created: string[] = [];

async function scaffold(id = 'com.example.hello'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-init-'));
  created.push(dir);
  await initProject({ projectDir: dir, id });
  return dir;
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
    await expect(readFile(join(dir, 'src', 'main.ts'), 'utf8')).resolves.toContain('connectOpenMini');
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
});
