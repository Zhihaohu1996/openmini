import type { OpenMiniManifest } from '@openmini/manifest';
import { BRIDGE_NAMESPACES } from '@openmini/shared';
import { describe, expect, it } from 'vitest';
import { computePermittedNamespaces, getMethodNamespace, isNamespaceKnown } from './capabilities';

function makeManifest(permissions: OpenMiniManifest['permissions']): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id: 'com.openmini.test',
    name: 'Test App',
    version: '0.1.0',
    entry: 'index.html',
    permissions,
  };
}

describe('computePermittedNamespaces', () => {
  it('maps each manifest permission to the identically-named namespace', () => {
    const permitted = computePermittedNamespaces(makeManifest(['storage', 'user']));
    expect(permitted.has('storage')).toBe(true);
    expect(permitted.has('user')).toBe(true);
    expect(permitted.has('navigation')).toBe(false);
  });

  it('returns an empty set for a manifest with no permissions', () => {
    const permitted = computePermittedNamespaces(makeManifest([]));
    expect(permitted.size).toBe(0);
  });

  // R3 defence-in-depth (Phase 8.5). Not reachable through a validated
  // manifest — `permissions` is constrained to four values upstream — so this
  // documents what the own-property guard buys if that constraint is ever
  // relaxed. Without it the prototype lookup returns a truthy non-namespace
  // and the permitted set gains a member that no namespace check expects.
  it.each(['constructor', 'toString', '__proto__', 'hasOwnProperty'])(
    'ignores the inherited permission name %j instead of admitting it',
    (permission) => {
      const manifest = makeManifest([permission] as unknown as OpenMiniManifest['permissions']);
      expect(computePermittedNamespaces(manifest).size).toBe(0);
    },
  );
});

describe('getMethodNamespace', () => {
  it('extracts the namespace before the first dot', () => {
    expect(getMethodNamespace('storage.get')).toBe('storage');
    expect(getMethodNamespace('navigation.close')).toBe('navigation');
  });

  it('returns the whole string when there is no dot', () => {
    expect(getMethodNamespace('nodot')).toBe('nodot');
  });
});

describe('isNamespaceKnown', () => {
  it('accepts every declared bridge namespace, including network', () => {
    // Driven from BRIDGE_NAMESPACES rather than a hand-kept list: this test
    // said "the three Phase 4 namespaces" and omitted `network` for the whole
    // of Phase 7, so the namespace added by that phase was never asserted.
    expect(BRIDGE_NAMESPACES).toHaveLength(4);
    expect(BRIDGE_NAMESPACES).toContain('network');
    for (const namespace of BRIDGE_NAMESPACES) {
      expect(isNamespaceKnown(namespace)).toBe(true);
    }
  });

  it('rejects an unknown namespace', () => {
    expect(isNamespaceKnown('filesystem')).toBe(false);
  });
});
