import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it } from 'vitest';
import type { MiniAppSandbox, PackageProvenance } from '../sandbox/types';
import { createStorageHandlers } from './handlers/storage';
import { createInMemoryStorageProvider } from './handlers/storageProvider';
import type { BridgeHandlerContext } from './types';

/**
 * The id-collision boundary — formerly the limitation test for it.
 *
 * Phase 9 left this file asserting a leak, on purpose: `openmini.storage.*`
 * scoped every key to the self-asserted `manifest.id`, so two packages from
 * anywhere at all could claim one id and share one store. The file existed so
 * that closing the gap would break a test naming what changed.
 *
 * Phase 10 closed it, and this is that break. `storage.ts` now derives its
 * scope from `ctx.provenance` (see `handlers/storageScope.ts`), so:
 *
 * - a **verified** package gets a namespace named by its id, which only a
 *   package signed by a registered key can ever reach;
 * - an **unverified** package gets a namespace qualified by the origin it was
 *   served from, so two origins claiming one id no longer collide;
 * - a package that never went through a load at all — a static fixture, a
 *   test — keeps its own namespace and is isolated from both.
 *
 * What did **not** change is pinned below rather than left to be
 * rediscovered: two unsigned packages served from the *same* origin sharing
 * an id still share a store.
 *
 * The protection is now two independent layers, and the fourth test still
 * describes the first one: a registered id is refused at *load* time, so an
 * impostor never reaches the bridge, let alone its storage. Scope derivation
 * is the second layer, and the one that covers every id the host has not
 * registered.
 *
 * See docs/security/bridge.md and docs/security/integrity.md.
 */

function manifestWithId(id: string): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id,
    name: 'Notes',
    version: '1.0.0',
    entry: 'index.html',
    permissions: ['storage'],
  };
}

const sandbox = {
  state: 'running',
  sessionId: 'session-1',
  start: async () => undefined,
  destroy: () => undefined,
  onStateChange: () => () => undefined,
} as unknown as MiniAppSandbox;

function contextFor(id: string, provenance?: PackageProvenance): BridgeHandlerContext {
  return { sandbox, manifest: manifestWithId(id), provenance };
}

const unsignedFrom = (baseUrl: string): PackageProvenance => ({
  baseUrl,
  identity: { verified: false, reason: 'unsigned' },
});

describe('storage is scoped by provenance, not by a self-asserted id', () => {
  it('refuses a second unsigned package from a different origin the first package data under the same id', async () => {
    // The leak this file was written to document. Both packages are unsigned
    // and both declare the same id; the only thing distinguishing them is
    // where they were served from, and that is now enough.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const victim = contextFor('com.example.notes', unsignedFrom('https://good.example/app/'));
    const impostor = contextFor('com.example.notes', unsignedFrom('https://evil.example/app/'));

    await handlers.set?.({ key: 'token', value: 'secret' }, victim);

    expect(await handlers.get?.({ key: 'token' }, impostor)).toBeNull();
    // ...and the victim still has its own data.
    expect(await handlers.get?.({ key: 'token' }, victim)).toBe('secret');
  });

  it('scopes on provenance: a verified write is not readable with undefined provenance', async () => {
    // The assertion whose name says what changed. `undefined` provenance means
    // no package load happened at all, which Phase 9 made a distinct state
    // from `verified: false`; it stays distinct here, in the data.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const verified: PackageProvenance = {
      baseUrl: 'https://good.example/app/',
      identity: { verified: true, id: 'com.example.notes', keyId: 'KEYID' },
    };

    await handlers.set?.({ key: 'k', value: 'v' }, contextFor('com.example.notes', verified));

    expect(await handlers.get?.({ key: 'k' }, contextFor('com.example.notes'))).toBeNull();
  });

  it('still separates different ids, which is the part that always held', async () => {
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });

    await handlers.set?.({ key: 'k', value: 'mine' }, contextFor('com.example.notes'));

    expect(await handlers.get?.({ key: 'k' }, contextFor('com.example.other'))).toBeNull();
  });

  it('keeps a registered id out of reach by refusing the load, not only by scoping storage', async () => {
    // The first of the two layers, unchanged by this phase. An impostor
    // claiming a registered id is refused by `verifyPackage` before a
    // dispatcher, a handler context, or a storage call exists. Scope
    // derivation is defence in depth behind it, and the layer that covers
    // every id the host has *not* registered.
    const { verifyPackage } = await import('../sandbox/packageVerification');
    const manifestJson = JSON.stringify(manifestWithId('com.example.notes'));

    const result = await verifyPackage({
      baseUrl: 'https://evil.example/app/',
      manifestId: 'com.example.notes',
      manifestVersion: '1.0.0',
      manifestBytes: new TextEncoder().encode(manifestJson),
      signatureText: undefined,
      trustStore: { 'com.example.notes': ['some-registered-spki'] },
    });

    expect(result.ok).toBe(false);
  });
});

describe('what Phase 10 did not close', () => {
  it('still shares a store between two unsigned packages on the same origin', async () => {
    // Pinned the way the old gap was pinned: executable rather than prose, so
    // that a future phase which closes it breaks a test naming what changed.
    //
    // A path is not a security boundary here. Anyone able to publish at
    // https://host.example/evil/ can publish at https://host.example/app/, so
    // scoping by path would buy no isolation while breaking every app that
    // moves. Two packages on one origin are already mutually trusting.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const atAppPath = contextFor('com.example.notes', unsignedFrom('https://host.example/app/'));
    const atOtherPath = contextFor('com.example.notes', unsignedFrom('https://host.example/evil/'));

    await handlers.set?.({ key: 'token', value: 'secret' }, atAppPath);

    expect(await handlers.get?.({ key: 'token' }, atOtherPath)).toBe('secret');
  });
});
