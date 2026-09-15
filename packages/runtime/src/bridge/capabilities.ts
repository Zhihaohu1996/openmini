import type { OpenMiniManifest } from '@openmini/manifest';
import { BRIDGE_NAMESPACES, type BridgeNamespace } from '@openmini/shared';

/**
 * Manifest permission -> bridge namespace, 1:1 by name (see
 * docs/security/bridge.md). Kept as an explicit map, not a bare cast,
 * so a future divergence between the two vocabularies is a one-line change
 * here rather than a silent assumption spread across the dispatcher.
 */
const PERMISSION_TO_NAMESPACE: Record<string, BridgeNamespace> = {
  storage: 'storage',
  navigation: 'navigation',
  user: 'user',
};

/**
 * Computes the set of bridge namespaces a Mini App may call, from its
 * manifest's `permissions` — closed over once at bridge-creation time and
 * never mutated afterward. A namespace absent from this set must never be
 * reachable, regardless of whether the exact method name is real.
 */
export function computePermittedNamespaces(manifest: OpenMiniManifest): ReadonlySet<BridgeNamespace> {
  const permitted = new Set<BridgeNamespace>();
  for (const permission of manifest.permissions) {
    const namespace = PERMISSION_TO_NAMESPACE[permission];
    if (namespace) {
      permitted.add(namespace);
    }
  }
  return permitted;
}

export function getMethodNamespace(method: string): string {
  const dot = method.indexOf('.');
  return dot === -1 ? method : method.slice(0, dot);
}

export function isNamespaceKnown(namespace: string): namespace is BridgeNamespace {
  return (BRIDGE_NAMESPACES as readonly string[]).includes(namespace);
}
