import { expect, test } from '@playwright/test';

test('storage.set/get and user.getProfile round-trip through the real bridge', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load' }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');
});
