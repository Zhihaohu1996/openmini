export const BRIDGE_DEMO_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.bridge-demo',
  name: 'Bridge Demo',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage', 'navigation', 'user'],
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
