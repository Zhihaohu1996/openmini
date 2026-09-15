import { StaticFixtureResourceProvider, getRuntimeInfo } from '@openmini/runtime';
import { getSdkInfo } from '@openmini/sdk';
import { Placeholder } from '@openmini/ui';
import { useEffect, useState } from 'react';
import bridgeDemoHtml from './miniapp/fixtures/bridge-demo/generated/index.html?raw';
import { BRIDGE_DEMO_MANIFEST_JSON, BRIDGE_DEMO_NO_STORAGE_MANIFEST_JSON } from './miniapp/fixtures/bridge-demo/manifest';
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
type Scenario = 'hello-sandbox' | 'invalid-manifest' | 'self-navigate' | 'bridge-demo' | 'bridge-demo-no-storage';

const SCENARIOS: readonly Scenario[] = [
  'hello-sandbox',
  'invalid-manifest',
  'self-navigate',
  'bridge-demo',
  'bridge-demo-no-storage',
];

function readScenario(): Scenario {
  const value = new URLSearchParams(window.location.search).get('scenario');
  return (SCENARIOS as readonly string[]).includes(value ?? '') ? (value as Scenario) : 'hello-sandbox';
}

function useScenarioDemo(scenario: Scenario): { manifestJson: string; provider: StaticFixtureResourceProvider | null } {
  const [provider, setProvider] = useState<StaticFixtureResourceProvider | null>(null);

  useEffect(() => {
    if (scenario === 'invalid-manifest' || scenario === 'bridge-demo' || scenario === 'bridge-demo-no-storage') {
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
    default:
      return { manifestJson: HELLO_SANDBOX_MANIFEST_JSON, provider };
  }
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
    </main>
  );
}
