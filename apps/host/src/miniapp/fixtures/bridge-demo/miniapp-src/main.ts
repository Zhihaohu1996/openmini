/**
 * The bridge-demo fixture's Mini App source — real @openmini/sdk usage,
 * bundled by esbuild (see ../../../../../scripts/build-bridge-demo-fixture.mjs)
 * into the fixture's single hashed inline script, rather than hand-rolled
 * duplicate client logic (contrast with hello-sandbox's bootstrapScript.ts).
 * Exercises storage/user round trips and exposes small test-only hooks the
 * Playwright specs under e2e/ call directly via frame.evaluate().
 */
import {
  createBridgeClient,
  createNavigationApi,
  createNetworkApi,
  createStorageApi,
  createUserApi,
  initOpenMiniBridge,
  type OpenMiniFetchInit,
} from '@openmini/sdk';

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

/** What a network.fetch attempt looked like from inside the sandbox. */
type NetworkAttempt =
  | { ok: true; status: number; body: string }
  | { ok: false; code: string; message: string };

interface BridgeDemoTestHooks {
  closeAndReport(): Promise<'resolved' | 'rejected'>;
  sendForgedSession(): void;
  sendAfterClose(): void;
  setPersistedValue(key: string, value: string): Promise<void>;
  getPersistedValue(key: string): Promise<string | null>;
  networkFetch(url: string, init?: OpenMiniFetchInit): Promise<NetworkAttempt>;
  directFetch(url: string): Promise<string>;
}

declare global {
  interface Window {
    __bridgeDemo?: BridgeDemoTestHooks;
  }
}

async function main(): Promise<void> {
  const { sessionId, port } = await initOpenMiniBridge();
  const client = createBridgeClient({ port, sessionId });
  const storage = createStorageApi(client);
  const navigation = createNavigationApi(client);
  const user = createUserApi(client);
  const network = createNetworkApi(client);

  try {
    await storage.set('greeting', 'hello from bridge');
    const value = await storage.get('greeting');
    setText('storage-result', value ?? '(null)');
  } catch (error) {
    setText('storage-result', `error:${error instanceof Error ? error.message : 'unknown'}`);
  }

  try {
    const profile = await user.getProfile();
    setText('user-result', JSON.stringify(profile));
  } catch (error) {
    setText('user-result', `error:${error instanceof Error ? error.message : 'unknown'}`);
  }

  window.__bridgeDemo = {
    async closeAndReport(): Promise<'resolved' | 'rejected'> {
      try {
        await navigation.close();
        setText('close-result', 'resolved');
        return 'resolved';
      } catch {
        setText('close-result', 'rejected');
        return 'rejected';
      }
    },
    sendForgedSession(): void {
      // Simulates a compromised/malicious Mini App forging a request with a
      // spoofed sessionId — the host must drop this, not crash or respond.
      port.postMessage({
        channel: 'openmini',
        version: 1,
        sessionId: 'not-the-real-session-id',
        type: 'request',
        requestId: 'forged-1',
        method: 'storage.get',
        params: { key: 'greeting' },
      });
    },
    sendAfterClose(): void {
      // Sent deliberately right after navigation.close() — the host must
      // reject/drop it rather than reaching a handler.
      port.postMessage({
        channel: 'openmini',
        version: 1,
        sessionId,
        type: 'request',
        requestId: 'after-close-1',
        method: 'storage.get',
        params: { key: 'greeting' },
      });
    },
    // Used by e2e/bridge-storage-persistence.spec.ts to prove storage
    // survives a real destroy -> reload cycle: the spec sets a value on one
    // Load, destroys, then reads it back on a second Load without setting it
    // again in between.
    setPersistedValue(key, value) {
      return storage.set(key, value);
    },
    getPersistedValue(key) {
      return storage.get(key);
    },
    // Used by the Phase 7 network specs. Reports the host's error *code*
    // rather than just failure, so a spec can assert how a failure was
    // classified — including that a blocked redirect is not distinguishable
    // from a CORS rejection.
    async networkFetch(url, init): Promise<NetworkAttempt> {
      try {
        const response = await network.fetch(url, init);
        setText('network-result', `${response.status}:${response.body}`);
        return { ok: true, status: response.status, body: response.body };
      } catch (error) {
        const code = (error as { code?: string }).code ?? 'UNKNOWN';
        const message = error instanceof Error ? error.message : 'unknown';
        setText('network-result', `error:${code}`);
        return { ok: false, code, message };
      }
    },
    // Proves the sandbox's own CSP still blocks direct network access: this
    // must fail even for a host the manifest allowlists, because the
    // allowlist only governs the host-mediated path.
    async directFetch(url): Promise<string> {
      try {
        const response = await fetch(url);
        return `unexpected-success:${response.status}`;
      } catch (error) {
        return `blocked:${error instanceof Error ? error.name : 'unknown'}`;
      }
    },
  };
}

void main();
