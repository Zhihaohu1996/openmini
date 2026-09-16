import { StaticFixtureResourceProvider, getRuntimeInfo, loadMiniAppFromUrl } from '@openmini/runtime';
import type { MiniAppResourceProvider } from '@openmini/runtime';
import { getSdkInfo } from '@openmini/sdk';
import { Placeholder } from '@openmini/ui';
import type { FormEvent } from 'react';
import { useEffect, useState } from 'react';
import bridgeDemoHtml from './miniapp/fixtures/bridge-demo/generated/index.html?raw';
import {
  BRIDGE_DEMO_MANIFEST_JSON,
  BRIDGE_DEMO_NETWORK_MANIFEST_JSON,
  BRIDGE_DEMO_NO_STORAGE_MANIFEST_JSON,
} from './miniapp/fixtures/bridge-demo/manifest';
import { buildHelloSandboxHtml } from './miniapp/fixtures/hello-sandbox/buildFixture';
import { HELLO_SANDBOX_MANIFEST_JSON } from './miniapp/fixtures/hello-sandbox/manifest';
import { buildSelfNavigateHtml } from './miniapp/fixtures/self-navigate/buildFixture';
import { SELF_NAVIGATE_MANIFEST_JSON } from './miniapp/fixtures/self-navigate/manifest';
import { MiniAppHost } from './miniapp/MiniAppHost';

const INVALID_MANIFEST_JSON = '{ this is not valid json';

/**
 * `?scenario=` drives which fixture the demo loads. Only used by the
 * Playwright specs under e2e/ to exercise the invalid-manifest gate, the
 * documented self-navigation limitation, and the Phase 4 bridge, through
 * the real running app instead of standing up a second host page for each
 * case.
 */
type Scenario =
  | 'hello-sandbox'
  | 'invalid-manifest'
  | 'self-navigate'
  | 'bridge-demo'
  | 'bridge-demo-no-storage'
  | 'bridge-demo-network';

const SCENARIOS: readonly Scenario[] = [
  'hello-sandbox',
  'invalid-manifest',
  'self-navigate',
  'bridge-demo',
  'bridge-demo-no-storage',
  'bridge-demo-network',
];

function readScenario(): Scenario {
  const value = new URLSearchParams(window.location.search).get('scenario');
  return (SCENARIOS as readonly string[]).includes(value ?? '') ? (value as Scenario) : 'hello-sandbox';
}

function useScenarioDemo(scenario: Scenario): { manifestJson: string; provider: StaticFixtureResourceProvider | null } {
  const [provider, setProvider] = useState<StaticFixtureResourceProvider | null>(null);

  useEffect(() => {
    if (
      scenario === 'invalid-manifest' ||
      scenario === 'bridge-demo' ||
      scenario === 'bridge-demo-no-storage' ||
      scenario === 'bridge-demo-network'
    ) {
      return;
    }
    let cancelled = false;
    setProvider(null);

    const build = scenario === 'self-navigate' ? buildSelfNavigateHtml : buildHelloSandboxHtml;
    void build().then((html) => {
      if (!cancelled) {
        setProvider(new StaticFixtureResourceProvider({ 'index.html': html }));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [scenario]);

  switch (scenario) {
    case 'invalid-manifest':
      return { manifestJson: INVALID_MANIFEST_JSON, provider: new StaticFixtureResourceProvider({}) };
    case 'self-navigate':
      return { manifestJson: SELF_NAVIGATE_MANIFEST_JSON, provider };
    case 'bridge-demo':
      return {
        manifestJson: BRIDGE_DEMO_MANIFEST_JSON,
        provider: new StaticFixtureResourceProvider({ 'index.html': bridgeDemoHtml }),
      };
    case 'bridge-demo-no-storage':
      return {
        manifestJson: BRIDGE_DEMO_NO_STORAGE_MANIFEST_JSON,
        provider: new StaticFixtureResourceProvider({ 'index.html': bridgeDemoHtml }),
      };
    case 'bridge-demo-network':
      return {
        manifestJson: BRIDGE_DEMO_NETWORK_MANIFEST_JSON,
        provider: new StaticFixtureResourceProvider({ 'index.html': bridgeDemoHtml }),
      };
    default:
      return { manifestJson: HELLO_SANDBOX_MANIFEST_JSON, provider };
  }
}

type RemoteLoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; reason: string }
  | { status: 'loaded'; manifestJson: string; provider: MiniAppResourceProvider };

/**
 * A host-operator-facing "load by URL" control, alongside the `?scenario=`
 * fixture picker: fetches a real, externally-hosted Mini App package (its
 * manifest discovered by `loadMiniAppFromUrl` itself) and hands the result
 * straight to `MiniAppHost`, unmodified. See docs/security/sandbox.md.
 */
function RemoteMiniAppLoader() {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<RemoteLoadState>({ status: 'idle' });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setState({ status: 'loading' });
    const result = await loadMiniAppFromUrl(url);
    if (result.ok) {
      setState({ status: 'loaded', manifestJson: result.manifestJson, provider: result.provider });
    } else {
      setState({ status: 'error', reason: result.reason });
    }
  }

  return (
    <section>
      <h2>Load a Mini App by URL</h2>
      <form onSubmit={(event) => void handleSubmit(event)}>
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://localhost:5173/miniapps/hello-remote"
          aria-label="Mini App package URL"
        />
        <button type="submit" disabled={state.status === 'loading'}>
          Load by URL
        </button>
      </form>
      {state.status === 'error' && <p data-testid="remote-load-error">{state.reason}</p>}
      {state.status === 'loaded' && (
        <div data-testid="remote-miniapp-host">
          <MiniAppHost manifestJson={state.manifestJson} resourceProvider={state.provider} />
        </div>
      )}
    </section>
  );
}

export function App() {
  const runtime = getRuntimeInfo();
  const sdk = getSdkInfo();
  const scenario = readScenario();
  const { manifestJson, provider } = useScenarioDemo(scenario);

  return (
    <main>
      <h1>OpenMini Host</h1>
      <ul>
        <li>runtime: {runtime.runtimeVersion}</li>
        <li>sdk: {sdk.sdkVersion}</li>
        <li>
          ui: <Placeholder label="ready" />
        </li>
      </ul>

      <h2>Sandbox demo: {scenario}</h2>
      {provider ? (
        <MiniAppHost manifestJson={manifestJson} resourceProvider={provider} />
      ) : (
        <p>preparing fixture...</p>
      )}

      <RemoteMiniAppLoader />
    </main>
  );
}
