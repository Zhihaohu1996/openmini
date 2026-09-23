/**
 * The storage-probe fixture's Mini App source.
 *
 * This exists because no other fixture can prove what Phase 10 does. The
 * signed Phase 9 fixtures carry no script at all, so they cannot reach the
 * bridge; `bridge-demo` can, but it is rendered through the host's
 * `?scenario=` path, which supplies no provenance and therefore lands in the
 * embedded tier — the one tier Phase 10 deliberately leaves alone.
 *
 * So this is a real @openmini/sdk Mini App, built by the CLI's
 * `assembleEntryDocument` and served from `public/miniapps/`, which means it
 * is loaded **by URL** and carries real provenance. Whatever it reads and
 * writes goes through the real dispatcher into real IndexedDB, under whatever
 * scope the package's identity earned it.
 *
 * It renders its own id so a spec can tell two builds apart on screen, and
 * exposes set/get hooks the specs drive via `frame.evaluate()`.
 */
import { createBridgeClient, createStorageApi, initOpenMiniBridge } from '@openmini/sdk';

interface StorageProbeHooks {
  set(key: string, value: string): Promise<void>;
  get(key: string): Promise<string | null>;
}

declare global {
  interface Window {
    __storageProbe?: StorageProbeHooks;
  }
}

async function main(): Promise<void> {
  const { sessionId, port } = await initOpenMiniBridge();
  const client = createBridgeClient({ port, sessionId });
  const storage = createStorageApi(client);

  window.__storageProbe = {
    set: (key, value) => storage.set(key, value),
    get: (key) => storage.get(key),
  };

  // One read before reporting ready. Scope resolution — and any migration it
  // implies — happens on the first storage call, so without this the host has
  // nothing to report until a spec happens to touch storage, and "ready"
  // would mean the bridge is up but say nothing about where storage landed.
  // Reading a key nobody writes keeps it a pure probe.
  await storage.get('__probe_boot');

  const ready = document.getElementById('probe-ready');
  if (ready) {
    ready.textContent = 'ready';
  }
}

void main().catch((error: unknown) => {
  // Reported in the DOM rather than only to the console: a spec that waits
  // for "ready" would otherwise hang for its whole timeout on a handshake
  // failure, and report nothing about why.
  const ready = document.getElementById('probe-ready');
  if (ready) {
    ready.textContent = `error:${error instanceof Error ? error.message : 'unknown'}`;
  }
});
