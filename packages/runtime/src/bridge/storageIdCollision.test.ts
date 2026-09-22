import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it } from 'vitest';
import type { MiniAppSandbox, PackageProvenance } from '../sandbox/types';
import { createStorageHandlers } from './handlers/storage';
import { createInMemoryStorageProvider } from './handlers/storageProvider';
import type { BridgeHandlerContext } from './types';

/**
 * A limitation test: what Phase 9 did *not* close.
 *
 * `openmini.storage.*` scopes every key to `ctx.manifest.id`, and
 * docs/security/bridge.md has recorded since Phase 4/5 that nothing verifies
 * a package is entitled to the id it claims — so two packages declaring the
 * same id share one store. Phase 9 narrows that, and it is worth being exact
 * about how far:
 *
 * - A **registered** id is now genuinely owned. `packageVerification` refuses
 *   to load a package claiming a registered id unless it is signed by a key
 *   the host registered for it, so an impostor cannot reach the bridge at
 *   all, let alone its storage.
 *
 * - An **unregistered** id is exactly as unprotected as before. Two unsigned
 *   packages declaring `com.example.notes` still share a store, because
 *   nothing in the host claims to know who owns that id.
 *
 * The storage handler is unchanged by this commit, deliberately. Gating
 * storage on `ctx.provenance` is a real design decision with real
 * consequences — it would orphan the data of every package that is currently
 * unsigned, and it needs a migration story rather than a conditional — so it
 * belongs to the phase that takes it, not to a test file. What this file
 * does is make the remaining gap executable instead of prose, so that if
 * someone later closes it the failure here is what tells them they did.
 *
 * See docs/security/integrity.md and docs/security/bridge.md.
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

describe('storage is still keyed on a self-asserted id (known limitation)', () => {
  it('lets a second unsigned package read the first package data under the same id', async () => {
    // Both packages come from different origins and neither is signed. The
    // only thing linking them is a string they each chose for themselves.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const victim = contextFor('com.example.notes', unsignedFrom('https://good.example/app/'));
    const impostor = contextFor('com.example.notes', unsignedFrom('https://evil.example/app/'));

    await handlers.set?.({ key: 'token', value: 'secret' }, victim);

    expect(await handlers.get?.({ key: 'token' }, impostor)).toBe('secret');
  });

  it('does not consult provenance when scoping a key', async () => {
    // Stated as its own assertion so that closing the gap breaks a test
    // whose name says what changed, rather than one about impostors.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });
    const verified: PackageProvenance = {
      baseUrl: 'https://good.example/app/',
      identity: { verified: true, id: 'com.example.notes', keyId: 'KEYID' },
    };

    await handlers.set?.({ key: 'k', value: 'v' }, contextFor('com.example.notes', verified));

    // Read back with no provenance at all: a static fixture, or any caller
    // that never went through the package-load path.
    expect(await handlers.get?.({ key: 'k' }, contextFor('com.example.notes'))).toBe('v');
  });

  it('still separates different ids, which is the part that does hold', async () => {
    // The limitation is about impersonation, not about scoping being absent.
    const handlers = createStorageHandlers({ provider: createInMemoryStorageProvider() });

    await handlers.set?.({ key: 'k', value: 'mine' }, contextFor('com.example.notes'));

    expect(await handlers.get?.({ key: 'k' }, contextFor('com.example.other'))).toBeNull();
  });
});

describe('what Phase 9 does close', () => {
  it('keeps a registered id out of reach by refusing the load, not by gating storage', async () => {
    // The protection for a registered id lives one layer up: an impostor is
    // refused by `verifyPackage` before a dispatcher, a handler context, or
    // a storage call exists. This asserts the shape of that defence rather
    // than re-testing it — packageVerification.test.ts owns the detail — so
    // that this file does not read as though storage were unprotected for
    // every id.
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
