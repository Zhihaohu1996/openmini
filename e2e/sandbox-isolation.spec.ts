import { expect, test } from '@playwright/test';

test('the Mini App cannot read/mutate the host DOM or navigate the top frame', async ({ page }) => {
  await page.goto('/');
  const hostTitleBefore = await page.title();
  const hostUrlBefore = page.url();

  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#hello')).toHaveText('Hello from OpenMini Sandbox');

  // The fixture's bootstrap script attempts `window.parent.document.title` and
  // records whether the browser's cross-origin access check blocked it.
  await expect(frame.locator('#isolation-check')).toHaveText('isolated', { timeout: 10_000 });

  // No allow-top-navigation was granted, so the fixture cannot navigate the
  // host page away from itself. The old assertion here was
  // `expect(page.url()).toContain('/')`, which is true of every URL ever
  // produced and so could not have failed; comparing against the URL captured
  // before the Mini App loaded is the check that was intended.
  expect(page.url()).toBe(hostUrlBefore);
  await expect(page).toHaveTitle(hostTitleBefore);
});
