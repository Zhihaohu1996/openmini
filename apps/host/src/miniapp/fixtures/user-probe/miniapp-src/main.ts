/**
 * The user-probe fixture's Mini App source.
 *
 * It exists for the reason `storage-probe` does: a `?scenario=` fixture is
 * rendered with no provenance at all, so it lands in the embedded tier and
 * can say nothing about a gate whose whole job is to tell a *verified*
 * package apart from an unverified one. This is a real @openmini/sdk Mini
 * App, assembled by the CLI and served from `public/miniapps/`, so it is
 * loaded by URL and carries provenance the verifier actually produced.
 *
 * Two builds share this source: one whose id is registered and signed by a
 * registered key, and one that is neither. The script is identical; only
 * the identity the host establishes for it differs, which is the point.
 *
 * It renders whatever `user.getProfile()` returned, verbatim. It does not
 * interpret it — a Mini App has no way to tell *why* it was handed an
 * anonymous profile, and this fixture must not pretend otherwise.
 */
import { createBridgeClient, createUserApi, initOpenMiniBridge } from '@openmini/sdk';

async function main(): Promise<void> {
  const { sessionId, port } = await initOpenMiniBridge();
  const client = createBridgeClient({ port, sessionId });
  const user = createUserApi(client);

  const profile = await user.getProfile();

  const idEl = document.getElementById('probe-user-id');
  if (idEl) {
    // `anonymous` rather than an empty string, so a spec distinguishes "the
    // host withheld the identity" from "the element never rendered".
    idEl.textContent = profile.id ?? 'anonymous';
  }
  const nameEl = document.getElementById('probe-user-name');
  if (nameEl) {
    nameEl.textContent = profile.displayName ?? 'anonymous';
  }

  const ready = document.getElementById('probe-ready');
  if (ready) {
    ready.textContent = 'ready';
  }
}

void main().catch((error: unknown) => {
  // Reported in the DOM rather than only to the console: a spec waiting for
  // "ready" would otherwise hang for its whole timeout and say nothing
  // about why. A `PERMISSION_DENIED` from the dispatcher lands here, which
  // is how the unpermitted case is observed.
  const ready = document.getElementById('probe-ready');
  if (ready) {
    ready.textContent = `error:${error instanceof Error ? error.message : 'unknown'}`;
  }
});
