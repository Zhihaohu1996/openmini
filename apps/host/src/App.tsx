import {
  StaticFixtureResourceProvider,
  getRuntimeInfo,
  loadMiniAppFromUrl,
} from '@openmini/runtime';
import type {
  MiniAppResourceProvider,
  PackageProvenance,
  PackageRefusalCode,
} from '@openmini/runtime';
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
import { describeRefusal, MiniAppHost } from './miniapp/MiniAppHost';
import { loadTrustConfig, readTrustConfigSource } from './miniapp/trustConfig';
import type { TrustConfigState } from './miniapp/trustConfig';

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
  return (SCENARIOS as readonly string[]).includes(value ?? '')
    ? (value as Scenario)
    : 'hello-sandbox';
}

function useScenarioDemo(scenario: Scenario): {
  manifestJson: string;
  provider: StaticFixtureResourceProvider | null;
} {
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
      return {
        manifestJson: INVALID_MANIFEST_JSON,
        provider: new StaticFixtureResourceProvider({}),
      };
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
  | { status: 'error'; reason: string; code?: PackageRefusalCode }
  | {
      status: 'loaded';
      manifestJson: string;
      provider: MiniAppResourceProvider;
      /**
       * Carried in state rather than re-derived at render: it is a property
       * of the load that produced this package, and re-deriving it from the
       * URL in the input box would read a value the operator may have edited
       * since.
       */
      provenance: PackageProvenance;
    };

/**
 * A host-operator-facing "load by URL" control, alongside the `?scenario=`
 * fixture picker: fetches a real, externally-hosted Mini App package (its
 * manifest discovered by `loadMiniAppFromUrl` itself) and hands the result
 * straight to `MiniAppHost`, unmodified. See docs/security/sandbox.md.
 */
function RemoteMiniAppLoader({ trustConfig }: { trustConfig: TrustConfigState }) {
  const [url, setUrl] = useState('');
  const [state, setState] = useState<RemoteLoadState>({ status: 'idle' });

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    // Checked here as well as by the disabled button, because the button is
    // a courtesy and this is the gate. Without a validated configuration
    // there is no trust store to pass, and the one value that is always
    // available -- no store at all -- is precisely the wrong answer: it
    // registers nothing, so nothing fails closed.
    if (trustConfig.status !== 'ready') {
      return;
    }
    setState({ status: 'loading' });
    // The host's trust configuration, read from a real openmini.trust.json
    // at startup. A package claiming one of these ids must be signed by a
    // key registered as active for it or it does not load at all --
    // unsigned included, which is what stops a signature being strippable,
    // and revoked included, which is what makes retiring a key mean
    // something.
    const result = await loadMiniAppFromUrl(url, { trustStore: trustConfig.trustStore });
    if (result.ok) {
      setState({
        status: 'loaded',
        manifestJson: result.manifestJson,
        provider: result.provider,
        provenance: result.provenance,
      });
    } else {
      setState({ status: 'error', reason: result.reason, code: result.code });
    }
  }

  return (
    <section>
      <h2>Load a Mini App by URL</h2>
      {trustConfig.status === 'loading' && (
        <p data-testid="trust-config-status">reading trust configuration...</p>
      )}
      {trustConfig.status === 'ready' && (
        <p data-testid="trust-config-status" data-trust-config="ready">
          trust configuration: {trustConfig.source} ({trustConfig.registeredIds} registered{' '}
          {trustConfig.registeredIds === 1 ? 'id' : 'ids'})
        </p>
      )}
      {trustConfig.status === 'unavailable' && (
        <p data-testid="trust-config-error" data-trust-config="unavailable">
          Loading a Mini App by URL is disabled: this host has no usable trust configuration, and
          carrying on without one would mean no id is registered — so nothing would fail closed and
          an impostor of a registered id would load as merely unverified.
          {'\n'}
          {trustConfig.reason}
        </p>
      )}
      <form onSubmit={(event) => void handleSubmit(event)}>
        <input
          type="text"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="http://localhost:5173/miniapps/hello-remote"
          aria-label="Mini App package URL"
          disabled={trustConfig.status !== 'ready'}
        />
        <button
          type="submit"
          disabled={state.status === 'loading' || trustConfig.status !== 'ready'}
        >
          Load by URL
        </button>
      </form>
      {state.status === 'error' && (
        <p data-testid="remote-load-error" data-refusal-code={state.code ?? ''}>
          {describeRefusal(state)}
        </p>
      )}
      {state.status === 'loaded' && (
        <div data-testid="remote-miniapp-host">
          <MiniAppHost
            manifestJson={state.manifestJson}
            resourceProvider={state.provider}
            provenance={state.provenance}
          />
        </div>
      )}
    </section>
  );
}

/**
 * Reads the host's trust configuration once, at startup.
 *
 * Deliberately not lazy. The configuration is a property of the host, not
 * of any particular load attempt, and an operator should find out that it
 * is broken when the page comes up rather than on the first package they
 * try — by which time "it did not load" is ambiguous between the package
 * and the host.
 */
function useTrustConfig(): TrustConfigState {
  const [state, setState] = useState<TrustConfigState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    void loadTrustConfig(readTrustConfigSource(window.location.search)).then((next) => {
      if (!cancelled) {
        setState(next);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return state;
}

export function App() {
  const runtime = getRuntimeInfo();
  const sdk = getSdkInfo();
  const scenario = readScenario();
  const { manifestJson, provider } = useScenarioDemo(scenario);
  const trustConfig = useTrustConfig();

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

      <RemoteMiniAppLoader trustConfig={trustConfig} />
    </main>
  );
}
