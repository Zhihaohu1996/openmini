import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/**
 * Phase 12 user identity, in a real browser.
 *
 * The unit suites decide the policy on values and W4 drives the real
 * verifier into the real dispatcher — but both stop at the runtime's edge.
 * Neither can see whether the *host* actually hands its profile to
 * `createUserHandlers`, because jsdom never executes a sandbox's `srcdoc`,
 * so `onBridgeReady` never fires and no dispatcher is ever built. Deleting
 * `{ profile: userProfile }` from the host breaks nothing in 1119 unit
 * tests. These specs are the only thing that notices.
 *
 * So everything here goes through the host's own "Load by URL" control
 * against packages served from `public/miniapps/`, with provenance the
 * verifier produced from real signatures. No `?scenario=`: that path
 * supplies no provenance at all and would land in the embedded tier, where
 * the answer is anonymous for a reason that has nothing to do with the gate.
 *
 * Three fixtures, one Mini App source, differing in exactly one respect
 * each (see apps/host/scripts/build-signed-fixtures.ts):
 *
 *   user-signed       registered, signed, declares `user`
 *   user-unsigned     declares `user`, proves no identity
 *   user-unpermitted  registered and signed, declares nothing
 *
 * Assertions are on what the Mini App renders and what the host reports —
 * the two things a person can actually see — rather than on runtime
 * internals.
 */

const HOST_ORIGIN = 'http://localhost:5173';

/** The host's synthetic demo values. This host authenticates nobody. */
const DEMO_USER_ID = 'demo-user';
const DEMO_DISPLAY_NAME = 'Demo User (synthetic, not a real account)';

async function loadAndBoot(page: Page, name: string): Promise<FrameLocator> {
  await page.getByLabel('Mini App package URL').fill(`${HOST_ORIGIN}/miniapps/${name}`);
  await page.getByRole('button', { name: 'Load by URL' }).click();

  const host = page.getByTestId('remote-miniapp-host');
  await expect(host).toHaveCount(1);
  await host.getByRole('button', { name: 'Load', exact: true }).click();

  return page.frameLocator('[data-testid="remote-miniapp-host"] iframe');
}

test.describe('a verified package is told who is using the host', () => {
  test('renders the demo identity it was given', async ({ page }) => {
    await page.goto('/');
    const frame = await loadAndBoot(page, 'user-signed');

    await expect(frame.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });

    // What the Mini App itself received, read off its own DOM. This is the
    // assertion that fails if the host stops passing its profile through.
    await expect(frame.locator('#probe-user-id')).toHaveText(DEMO_USER_ID);
    await expect(frame.locator('#probe-user-name')).toHaveText(DEMO_DISPLAY_NAME);
  });

  test('says so in the host, for the operator', async ({ page }) => {
    await page.goto('/');
    await loadAndBoot(page, 'user-signed');

    const line = page.getByTestId('miniapp-user-identity');
    await expect(line).toHaveAttribute('data-disclosure', 'shared');
    await expect(line).toContainText(DEMO_USER_ID);
  });

  test('is verified, so the answer is about the gate and not the fixture', async ({ page }) => {
    // Guards the three specs above from passing for the wrong reason. If
    // this package stopped verifying, "received the profile" would be a
    // claim about a package that never passed the check it is meant to
    // demonstrate passing.
    await page.goto('/');
    await loadAndBoot(page, 'user-signed');

    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'true');
  });
});

test.describe('an unverified package is told nothing', () => {
  test('renders anonymous, and never the host identity', async ({ page }) => {
    await page.goto('/');
    const frame = await loadAndBoot(page, 'user-unsigned');

    await expect(frame.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });

    await expect(frame.locator('#probe-user-id')).toHaveText('anonymous');
    await expect(frame.locator('#probe-user-name')).toHaveText('anonymous');
    // Stated negatively as well: neither field may carry any part of the
    // host's profile, however the gate were to fail.
    await expect(frame.locator('#probe-user-id')).not.toContainText(DEMO_USER_ID);
    await expect(frame.locator('#probe-user-name')).not.toContainText('Demo User');
  });

  test('loads and runs normally — withheld identity is not a refusal', async ({ page }) => {
    // The package is unverified, not rejected. It boots, the bridge works,
    // and `getProfile` succeeds; it simply learns nothing. A Mini App must
    // not be able to tell "withheld" from "nobody is signed in".
    await page.goto('/');
    const frame = await loadAndBoot(page, 'user-unsigned');

    await expect(frame.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });
    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'false');
  });

  test('the host reports the identity as withheld, and why', async ({ page }) => {
    // The asymmetry the phase is built on: the Mini App gets one
    // indistinguishable value, the operator gets the reason.
    await page.goto('/');
    await loadAndBoot(page, 'user-unsigned');

    const line = page.getByTestId('miniapp-user-identity');
    await expect(line).toHaveAttribute('data-disclosure', 'withheld');
    await expect(line).toContainText('not verified');
    await expect(line).not.toContainText(DEMO_USER_ID);
  });
});

test.describe('the permission gate is separate from the provenance gate', () => {
  test('refuses a verified package that never declared the user permission', async ({ page }) => {
    // Verified, and still refused. The dispatcher denies before any handler
    // runs, so this is PERMISSION_DENIED reaching the Mini App as a
    // rejection -- deliberately not collapsed into an anonymous profile,
    // which is a different answer to a different question.
    await page.goto('/');
    const frame = await loadAndBoot(page, 'user-unpermitted');

    // The probe reports a rejected call in its own DOM rather than only to
    // the console, so the denial is observable from outside the frame.
    await expect(frame.locator('#probe-ready')).toHaveText(/^error:/, { timeout: 15_000 });
    await expect(frame.locator('#probe-ready')).toContainText('does not have the required');

    // It never reached the handler, so it rendered neither an identity nor
    // an anonymous one -- the elements are still at their initial value.
    await expect(frame.locator('#probe-user-id')).toHaveText('pending');
  });

  test('is verified, so the refusal is about permission alone', async ({ page }) => {
    await page.goto('/');
    await loadAndBoot(page, 'user-unpermitted');

    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'true');
    await expect(page.getByTestId('miniapp-user-identity')).toHaveAttribute(
      'data-disclosure',
      'not-requested',
    );
  });

  test('a denial and a withheld identity are different outcomes', async ({ page }) => {
    // Pinned against each other, because collapsing them is the plausible
    // simplification: both end with a Mini App that knows no user.
    await page.goto('/');
    const unpermitted = await loadAndBoot(page, 'user-unpermitted');
    await expect(unpermitted.locator('#probe-ready')).toHaveText(/^error:/, { timeout: 15_000 });

    await page.goto('/');
    const unverified = await loadAndBoot(page, 'user-unsigned');
    await expect(unverified.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });
    await expect(unverified.locator('#probe-user-id')).toHaveText('anonymous');
  });
});

test.describe('nothing about the identity persists', () => {
  test('a reload re-derives it rather than remembering it', async ({ page }) => {
    // Destroying the sandbox is the whole of sign-out, because nothing was
    // ever written. The verified package gets the profile again on the next
    // load for the same reason it got it the first time -- the host still
    // supplies one and the package still verifies -- not because anything
    // was stored.
    await page.goto('/');
    const first = await loadAndBoot(page, 'user-signed');
    await expect(first.locator('#probe-user-id')).toHaveText(DEMO_USER_ID, { timeout: 15_000 });

    await page.reload();
    const unverified = await loadAndBoot(page, 'user-unsigned');

    // The unverified package loaded after a verified one saw the identity,
    // in the same browser, and still learns nothing.
    await expect(unverified.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });
    await expect(unverified.locator('#probe-user-id')).toHaveText('anonymous');
  });
});
