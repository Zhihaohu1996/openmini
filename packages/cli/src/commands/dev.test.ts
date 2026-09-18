import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { startDevServer, type DevServer } from './dev.js';

const MANIFEST = `{
  "schemaVersion": 1,
  "id": "com.example.served",
  "name": "Served",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": []
}
`;

let server: DevServer | null = null;

async function makePackage() {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-dev-'));
  await writeFile(join(dir, 'openmini.json'), MANIFEST, 'utf8');
  await writeFile(join(dir, 'index.html'), '<!doctype html><html></html>', 'utf8');
  // A sibling of the package root that must never be reachable.
  await writeFile(join(dir, '..', 'openmini-dev-secret.txt'), 'SECRET', 'utf8').catch(
    () => undefined,
  );
  return dir;
}

async function serve(dir: string): Promise<DevServer> {
  // Port 0 lets the OS choose a free port, so parallel tests never collide.
  server = await startDevServer({ packageDir: dir, port: 0 });
  return server;
}

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('dev server binding', () => {
  it('binds loopback only, never the LAN', async () => {
    const dir = await makePackage();
    const started = await serve(dir);
    expect(started.url.startsWith('http://127.0.0.1:')).toBe(true);

    // Prove it by trying the machine's external IPv4 address: a server bound
    // to 0.0.0.0 would answer there too.
    const external = Object.values(networkInterfaces())
      .flat()
      .find((iface) => iface && iface.family === 'IPv4' && !iface.internal);

    if (external) {
      await expect(
        fetch(`http://${external.address}:${started.port}/openmini.json`, {
          signal: AbortSignal.timeout(2000),
        }),
      ).rejects.toThrow();
    }
  });
});

describe('dev server file serving', () => {
  it('serves the manifest with a JSON content type', async () => {
    const started = await serve(await makePackage());
    const response = await fetch(`${started.url}openmini.json`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.text()).toBe(MANIFEST);
  });

  it('serves the entry document at the package root', async () => {
    const started = await serve(await makePackage());
    const response = await fetch(started.url);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/html');
  });

  it('ignores query strings and fragments when selecting a file', async () => {
    const started = await serve(await makePackage());
    expect((await fetch(`${started.url}openmini.json?v=1`)).status).toBe(200);
  });

  it('is reachable at a base URL loadMiniAppFromUrl accepts', async () => {
    const started = await serve(await makePackage());
    // Same shape normalizePackageBaseUrl produces: http, no query/hash, trailing slash.
    const manifest = await fetch(new URL('openmini.json', started.url));
    expect(manifest.status).toBe(200);
  });
});

describe('dev server hardening', () => {
  it.each([
    ['parent traversal', '../openmini-dev-secret.txt'],
    ['encoded traversal', '..%2Fopenmini-dev-secret.txt'],
    ['double-encoded traversal', '..%252Fopenmini-dev-secret.txt'],
    ['nested traversal', 'a/../../openmini-dev-secret.txt'],
  ])('refuses %s', async (_label, path) => {
    const started = await serve(await makePackage());
    const response = await fetch(`${started.url}${path}`);

    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('SECRET');
  });

  it('refuses an absolute path', async () => {
    const started = await serve(await makePackage());
    const response = await fetch(`${started.url}//etc/passwd`);
    expect(response.status).not.toBe(200);
  });

  it('never lists a directory', async () => {
    const dir = await makePackage();
    await mkdir(join(dir, 'sub'), { recursive: true });
    await writeFile(join(dir, 'sub', 'inner.html'), '<html></html>', 'utf8');
    const started = await serve(dir);

    const response = await fetch(`${started.url}sub`);
    expect(response.status).not.toBe(200);
    expect(await response.text()).not.toContain('inner.html');
  });

  it('refuses an unknown extension rather than guessing a type', async () => {
    const dir = await makePackage();
    await writeFile(join(dir, 'notes.txt'), 'plain', 'utf8');
    const started = await serve(dir);

    const response = await fetch(`${started.url}notes.txt`);
    expect(response.status).toBe(415);
  });

  it('returns 404 for a missing file, indistinguishable from a directory', async () => {
    const started = await serve(await makePackage());
    expect((await fetch(`${started.url}missing.html`)).status).toBe(404);
  });
});
