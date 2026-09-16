export const BRIDGE_DEMO_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.bridge-demo',
  name: 'Bridge Demo',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage', 'navigation', 'user'],
});

/**
 * Grants `network` with an exact-hostname allowlist — used by the Phase 7
 * network e2e specs. `localhost` and `127.0.0.1` are the dev fixture server;
 * `127.0.0.1` is a genuinely different origin from the `localhost` host page,
 * so it exercises real cross-origin CORS. `blocked.example.com` is never
 * listed, so requests to it must be denied.
 */
export const BRIDGE_DEMO_NETWORK_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.bridge-demo-network',
  name: 'Bridge Demo (network)',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage', 'navigation', 'user', 'network'],
  network: { domains: ['localhost', '127.0.0.1'] },
});

/** Grants no storage permission — used by the permission-denied e2e spec. */
export const BRIDGE_DEMO_NO_STORAGE_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.bridge-demo-no-storage',
  name: 'Bridge Demo (no storage)',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['navigation', 'user'],
});
