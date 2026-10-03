import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Phase 12 W5. The three identity fixtures, asserted against what is
 * actually served rather than against the generator's intent.
 *
 * The browser evidence in W7 depends entirely on these three differing in
 * exactly one respect each. If the generator stopped signing `user-signed`,
 * or quietly gave `user-unpermitted` the `user` permission, the W7 specs
 * would still pass — they would simply be asserting a different thing than
 * their names claim, which is the failure mode worth catching early.
 *
 * `apps/host`'s test script runs `build:fixtures` first, so this always
 * reads freshly generated artifacts.
 */
const miniapps = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'public',
  'miniapps',
);

const manifestOf = async (dir: string): Promise<Record<string, unknown>> =>
  JSON.parse(await readFile(join(miniapps, dir, 'openmini.json'), 'utf8')) as Record<
    string,
    unknown
  >;

const isSigned = async (dir: string): Promise<boolean> =>
  readFile(join(miniapps, dir, 'openmini.sig.json'), 'utf8').then(
    () => true,
    () => false,
  );

const trustedIds = async (): Promise<string[]> => {
  const raw = await readFile(join(miniapps, '..', 'openmini.trust.json'), 'utf8');
  return Object.keys((JSON.parse(raw) as { packages: Record<string, unknown> }).packages);
};

describe('the identity fixtures differ in exactly one respect each', () => {
  it('user-signed is registered, signed, and asks for the user permission', async () => {
    expect(await manifestOf('user-signed')).toMatchObject({
      id: 'com.openmini.user-signed',
      permissions: ['user'],
    });
    expect(await isSigned('user-signed')).toBe(true);
    expect(await trustedIds()).toContain('com.openmini.user-signed');
  });

  it('user-unsigned asks for the same permission and proves no identity', async () => {
    // Same request, no signature, not registered. The only difference from
    // user-signed is the identity the host can establish -- which is what
    // makes the pair evidence about the gate rather than about two
    // unrelated packages.
    expect(await manifestOf('user-unsigned')).toMatchObject({
      id: 'com.openmini.user-unsigned',
      permissions: ['user'],
    });
    expect(await isSigned('user-unsigned')).toBe(false);
    expect(await trustedIds()).not.toContain('com.openmini.user-unsigned');
  });

  it('user-unpermitted is verifiable and declares no permissions at all', async () => {
    // The independence case: identity established, nothing requested. If
    // this ever gained the `user` permission the W7 spec asserting
    // PERMISSION_DENIED would be asserting nothing.
    expect(await manifestOf('user-unpermitted')).toMatchObject({
      id: 'com.openmini.user-unpermitted',
      permissions: [],
    });
    expect(await isSigned('user-unpermitted')).toBe(true);
    expect(await trustedIds()).toContain('com.openmini.user-unpermitted');
  });

  it('all three run the same Mini App source', async () => {
    // Same script, three identities. If the documents diverged, a
    // difference in behaviour could be the fixture rather than the gate.
    const [signed, unsigned, unpermitted] = await Promise.all(
      ['user-signed', 'user-unsigned', 'user-unpermitted'].map((dir) =>
        readFile(join(miniapps, dir, 'index.html'), 'utf8'),
      ),
    );

    // The documents differ only in their <title> and <h1>, which carry the
    // fixture name; the inlined script is byte-identical.
    const scriptOf = (html: string) => /<script[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];

    expect(scriptOf(signed as string)).toBeTruthy();
    expect(scriptOf(unsigned as string)).toBe(scriptOf(signed as string));
    expect(scriptOf(unpermitted as string)).toBe(scriptOf(signed as string));
  });
});
