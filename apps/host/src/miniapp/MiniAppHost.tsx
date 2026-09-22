import {
  createBridgeDispatcher,
  createIndexedDbStorageProvider,
  createMiniAppSandbox,
  createNavigationHandlers,
  createNetworkHandlers,
  createStorageHandlers,
  createUserHandlers,
  gateManifest,
} from '@openmini/runtime';
import type {
  MiniAppResourceProvider,
  MiniAppSandbox,
  PackageProvenance,
  SandboxState,
} from '@openmini/runtime';
import { useEffect, useMemo, useRef, useState } from 'react';

export interface MiniAppHostProps {
  manifestJson: string;
  resourceProvider: MiniAppResourceProvider;
  /**
   * Set only by the remote package-loading path, which gets it from
   * `loadMiniAppFromUrl`. The fixture/scenario path leaves it `undefined`
   * rather than supplying an unverified-looking stand-in: a fixture did not
   * fail a check, it was never subject to one. See
   * `SandboxOptions.provenance`.
   */
  provenance?: PackageProvenance;
}

/**
 * **Contract: these props are immutable for the lifetime of a mounted
 * `MiniAppHost`.** Changing either one in place would leave the existing
 * sandbox running against the previous manifest/provider, because the
 * teardown below is keyed to unmount rather than to a prop change.
 *
 * Callers satisfy this today without relying on it being enforced:
 * `RemoteMiniAppLoader` passes through a `loading` state that unmounts this
 * component — firing the cleanup and destroying the sandbox — before
 * remounting with new values, and the fixture `scenario` never changes
 * without a page reload. So the stale-sandbox path is not reachable; this is
 * latent debt, recorded rather than fixed, and no code depends on the comment.
 * A caller that swaps props in place must remount instead (e.g. via `key`).
 */

type DisplayState = SandboxState | 'idle';

/**
 * Minimal host wiring for a single Mini App: gates the manifest, then lets
 * the caller load/destroy a sandbox and see its lifecycle state. This is
 * intentionally thin — it owns no RPC/capability logic, only the sandbox's
 * lifecycle and the DOM container it renders into. See docs/security/sandbox.md.
 */
export function MiniAppHost({ manifestJson, resourceProvider, provenance }: MiniAppHostProps) {
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
      provenance,
      container: containerRef.current,
      onBridgeReady: (port) => {
        createBridgeDispatcher({
          manifest,
          sandbox,
          port,
          provenance,
          handlers: {
            storage: createStorageHandlers({ provider: createIndexedDbStorageProvider() }),
            navigation: createNavigationHandlers(),
            user: createUserHandlers(),
            // Plain http to loopback is a dev/test affordance only, so it is
            // tied to the dev build rather than to hostname shape; a
            // production bundle gets https-only.
            network: createNetworkHandlers({ allowInsecureLoopback: import.meta.env.DEV }),
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
      <button
        type="button"
        onClick={handleLoad}
        disabled={state !== 'idle' && state !== 'destroyed'}
      >
        Load
      </button>
      <button
        type="button"
        onClick={handleDestroy}
        disabled={state === 'idle' || state === 'destroyed'}
      >
        Destroy
      </button>
      <div ref={containerRef} data-testid="miniapp-container" />
    </div>
  );
}
