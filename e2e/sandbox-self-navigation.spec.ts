import { expect, test } from '@playwright/test';

/**
 * Documents the known Phase 3 limitation described in
 * docs/security/sandbox.md "Known limitation: self-navigation is not fully
 * prevented": `connect-src 'none'` does not stop the sandboxed frame from
 * navigating its own browsing context. This test pins the runtime's
 * after-the-fact detection (a second `load` event moves a running sandbox to
 * `error`) rather than asserting the navigation itself is prevented — it is
 * not.
 */
test('self-navigation of the sandboxed frame is detected after the fact, not prevented', async ({ page }) => {
  await page.goto('/?scenario=self-navigate');
  const status = page.getByTestId('miniapp-status');

  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(status).toHaveText('status: running', { timeout: 10_000 });

  // The fixture navigates itself to about:blank ~200ms after the handshake.
  await expect(status).toHaveText('status: error', { timeout: 10_000 });
});
