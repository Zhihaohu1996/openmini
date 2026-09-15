import type { OpenMiniManifest } from '@openmini/manifest';
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
  it('accepts the three Phase 4 namespaces', () => {
    expect(isNamespaceKnown('storage')).toBe(true);
    expect(isNamespaceKnown('navigation')).toBe(true);
    expect(isNamespaceKnown('user')).toBe(true);
  });

  it('rejects an unknown namespace', () => {
    expect(isNamespaceKnown('filesystem')).toBe(false);
  });
});
