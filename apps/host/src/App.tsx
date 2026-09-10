import { getRuntimeInfo } from '@openmini/runtime';
import { getSdkInfo } from '@openmini/sdk';
import { Placeholder } from '@openmini/ui';

export function App() {
  const runtime = getRuntimeInfo();
  const sdk = getSdkInfo();

  return (
    <main>
      <h1>OpenMini Host</h1>
      <p>Phase 1 scaffold — no mini-apps are loaded yet.</p>
      <ul>
        <li>runtime: {runtime.runtimeVersion}</li>
        <li>sdk: {sdk.sdkVersion}</li>
        <li>
          ui: <Placeholder label="ready" />
        </li>
      </ul>
    </main>
  );
}
