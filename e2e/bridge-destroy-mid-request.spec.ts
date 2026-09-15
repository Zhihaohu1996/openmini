import { expect, test } from '@playwright/test';

test('destroying the sandbox mid-request causes no crash or unhandled rejection', async ({ page }) => {
  const pageErrors: Error[] = [];
  page.on('pageerror', (error) => pageErrors.push(error));

  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load' }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');

  // Fire a request and destroy the sandbox immediately after, without
  // waiting for a response.
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __bridgeDemo: { sendAfterClose(): void } }).__bridgeDemo.sendAfterClose();
  });
  await page.getByRole('button', { name: 'Destroy' }).click();
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed');

  await page.waitForTimeout(200);
  expect(pageErrors).toEqual([]);
});
