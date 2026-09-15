import {
  createBridgeDispatcher,
  createIndexedDbStorageProvider,
  createMiniAppSandbox,
  createNavigationHandlers,
  createStorageHandlers,
  createUserHandlers,
  gateManifest,
} from '@openmini/runtime';
import type { MiniAppResourceProvider, MiniAppSandbox, SandboxState } from '@openmini/runtime';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface MiniAppHostProps {
  manifestJson: string;
  resourceProvider: MiniAppResourceProvider;
}

type DisplayState = SandboxState | 'idle';

/**
 * Minimal host wiring for a single Mini App: gates the manifest, then lets
 * the caller load/destroy a sandbox and see its lifecycle state. This is
 * intentionally thin — it owns no RPC/capability logic, only the sandbox's
 * lifecycle and the DOM container it renders into. See docs/security/sandbox.md.
 */
export function MiniAppHost({ manifestJson, resourceProvider }: MiniAppHostProps) {
  const gateResult = useMemo(() => gateManifest(manifestJson), [manifestJson]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sandboxRef = useRef<MiniAppSandbox | null>(null);
  const [state, setState] = useState<DisplayState>('idle');

  useEffect(() => {
    return () => {
      sandboxRef.current?.destroy();
      sandboxRef.current = null;
    };
  }, []);

  if (!gateResult.ok) {
    return (
      <div>
        <p data-testid="miniapp-status">manifest invalid: {gateResult.reason}</p>
      </div>
    );
  }

  const manifest = gateResult.manifest;

  function handleLoad() {
    if (sandboxRef.current || !containerRef.current) {
      return;
    }
    const sandbox = createMiniAppSandbox({
      manifest,
      resourceProvider,
      container: containerRef.current,
      onBridgeReady: (port) => {
        createBridgeDispatcher({
          manifest,
          sandbox,
          port,
          handlers: {
            storage: createStorageHandlers({ provider: createIndexedDbStorageProvider() }),
            navigation: createNavigationHandlers(),
            user: createUserHandlers(),
          },
        });
      },
    });
    sandboxRef.current = sandbox;
    sandbox.onStateChange((next) => setState(next));
    setState(sandbox.state);
    void sandbox.start();
  }

  function handleDestroy() {
    sandboxRef.current?.destroy();
    sandboxRef.current = null;
    setState('destroyed');
  }

  return (
    <div>
      <p data-testid="miniapp-status">status: {state}</p>
      <button type="button" onClick={handleLoad} disabled={state !== 'idle' && state !== 'destroyed'}>
        Load
      </button>
      <button type="button" onClick={handleDestroy} disabled={state === 'idle' || state === 'destroyed'}>
        Destroy
      </button>
      <div ref={containerRef} data-testid="miniapp-container" />
    </div>
  );
}
