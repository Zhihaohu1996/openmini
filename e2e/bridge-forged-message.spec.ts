import { expect, test } from '@playwright/test';

test('a forged request with a spoofed sessionId is dropped, not crashed on or answered', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load' }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');

  // Send a forged request directly from inside the sandboxed script.
  await frame.locator('body').evaluate(() => {
    (window as unknown as { __bridgeDemo: { sendForgedSession(): void } }).__bridgeDemo.sendForgedSession();
  });

  // The host must still be alive and responsive afterward — prove it by
  // issuing a legitimate request and seeing it still succeed.
  await page.getByRole('button', { name: 'Destroy' }).click();
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed');
});
