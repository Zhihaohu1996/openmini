/**
 * The bridge-demo fixture's Mini App source — real @openmini/sdk usage,
 * bundled by esbuild (see ../../../../../scripts/build-bridge-demo-fixture.mjs)
 * into the fixture's single hashed inline script, rather than hand-rolled
 * duplicate client logic (contrast with hello-sandbox's bootstrapScript.ts).
 * Exercises storage/user round trips and exposes small test-only hooks the
 * Playwright specs under e2e/ call directly via frame.evaluate().
 */
import { createBridgeClient, createNavigationApi, createStorageApi, createUserApi, initOpenMiniBridge } from '@openmini/sdk';

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = text;
  }
}

interface BridgeDemoTestHooks {
  closeAndReport(): Promise<'resolved' | 'rejected'>;
  sendForgedSession(): void;
  sendAfterClose(): void;
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
  };
}

void main();
