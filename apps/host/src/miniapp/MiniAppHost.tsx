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
  PackageRefusalCode,
  SandboxState,
  StorageScopeResolution,
} from '@openmini/runtime';
import { TRUST_CONFIG_FILENAME } from '@openmini/shared';
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
  /**
   * Package ids whose pre-Phase-10 bare-id storage this host will carry
   * forward when the package loads verified. Off unless the operator says
   * otherwise, because those bytes have no trustworthy writer — see
   * `StorageHandlerOptions.adoptLegacyScopeForIds`.
   */
  adoptLegacyStorageForIds?: ReadonlySet<string>;
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
 * Where this package's storage actually landed, and whether anything was
 * carried into it.
 *
 * Phase 10 moves a loaded package's data from the bare `manifest.id` into a
 * namespace derived from its provenance. A move nobody can observe is
 * indistinguishable from data loss, so the host says which namespace was
 * used and what the migration did — including when it deliberately did
 * nothing.
 *
 * `attested: false` is surfaced rather than hidden: adopted data was
 * inherited, and a signature attests the package, never the data the
 * package inherits.
 */
export function describeStorageScope(resolution: StorageScopeResolution): string {
  const tier =
    resolution.tier === 'verified'
      ? 'verified identity'
      : resolution.tier === 'origin'
        ? 'origin-bound (unverified)'
        : 'built-in fixture';

  const { outcome } = resolution;
  switch (outcome.kind) {
    case 'adopted':
      return `storage: ${tier} — carried ${outcome.entriesCopied} entr${
        outcome.entriesCopied === 1 ? 'y' : 'ies'
      } from ${outcome.sourceTier} storage (inherited, not attested)`;
    case 'already-complete':
      return `storage: ${tier} — previously migrated`;
    case 'not-adopted':
      return `storage: ${tier} — nothing carried forward (${outcome.reason})`;
    case 'not-applicable':
      return `storage: ${tier}`;
  }
}

/**
 * How a package's identity is described to the operator.
 *
 * Three outcomes, not two, and the wording keeps them apart. "unsigned"
 * says nobody vouched for this package; "untrusted-key" says somebody did,
 * but not anybody this host recognizes. Collapsing them into "not verified"
 * would hide that the second one names a specific key that could be added
 * to a trust store, while the first has nothing to add.
 *
 * Nothing is shown at all when provenance is `undefined`: this host did not
 * load a package, it rendered a built-in fixture, and inventing a
 * verification result for it would be the same lie in the UI that
 * synthesizing a default provenance would have been in the type.
 */
function describeProvenance(provenance: PackageProvenance): string {
  if (provenance.identity.verified) {
    return `verified: signed by trusted key ${provenance.identity.keyId}`;
  }
  return provenance.identity.reason === 'unsigned'
    ? 'unsigned: no signature, so nothing vouches for this package'
    : 'untrusted key: signed, but not by a key this host trusts';
}

/**
 * How a *refused* load is described to the operator.
 *
 * The counterpart to `describeProvenance`, and it exists for the same
 * reason: a package that was refused never becomes provenance, so the
 * refusal is the only thing the operator ever sees about it, and the three
 * trust-store refusals have three different remedies.
 *
 * **A revoked key is the one this phase added, and it is not a variant of
 * "untrusted".** An untrusted key is one this host has never heard of, and
 * the remedy is to decide whether to register it. A revoked key is one this
 * host registered and then deliberately retired, and the remedy is for the
 * publisher to re-sign with its current key — adding the revoked key back
 * would be undoing a decision somebody made on purpose. Rendering them with
 * one message would hide exactly that.
 *
 * Selected on `code`, never on `reason`. The prose is what an operator
 * reads; matching on it would make the wording load-bearing and would break
 * silently the first time somebody improved a sentence. Codes without a
 * message of their own fall through to the reason the runtime produced,
 * which is already accurate — this adds remedies, it does not restate
 * refusals.
 */
export function describeRefusal(refusal: { reason: string; code?: PackageRefusalCode }): string {
  switch (refusal.code) {
    case 'revoked-key':
      return `${refusal.reason}\nThis key was registered and then revoked. Re-signing the package with the publisher's current key is the fix; re-trusting this one would undo the revocation.`;
    case 'untrusted-key':
      return `${refusal.reason}\nThis host has never registered that key. Add it to ${TRUST_CONFIG_FILENAME} only if you know it belongs to the publisher of this id.`;
    case 'unsigned-registered':
      return `${refusal.reason}\nA registered id must be signed. An unsigned package claiming one is refused rather than loaded unverified, so that stripping a signature is not a way past the check.`;
    default:
      return refusal.reason;
  }
}

/**
 * Minimal host wiring for a single Mini App: gates the manifest, then lets
 * the caller load/destroy a sandbox and see its lifecycle state. This is
 * intentionally thin — it owns no RPC/capability logic, only the sandbox's
 * lifecycle and the DOM container it renders into. See docs/security/sandbox.md.
 */
export function MiniAppHost({
  manifestJson,
  resourceProvider,
  provenance,
  adoptLegacyStorageForIds,
}: MiniAppHostProps) {
  const gateResult = useMemo(() => gateManifest(manifestJson), [manifestJson]);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sandboxRef = useRef<MiniAppSandbox | null>(null);
  const [state, setState] = useState<DisplayState>('idle');
  const [storageScope, setStorageScope] = useState<StorageScopeResolution | null>(null);

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
            storage: createStorageHandlers({
              provider: createIndexedDbStorageProvider(),
              adoptLegacyScopeForIds: adoptLegacyStorageForIds,
              onScopeResolved: setStorageScope,
            }),
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
      {provenance && (
        <p data-testid="miniapp-provenance" data-verified={String(provenance.identity.verified)}>
          {describeProvenance(provenance)}
        </p>
      )}
      {storageScope && (
        <p data-testid="miniapp-storage-scope" data-tier={storageScope.tier}>
          {describeStorageScope(storageScope)}
        </p>
      )}
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
