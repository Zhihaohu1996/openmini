import { expect, test } from '@playwright/test';

test('a Mini App without the storage permission gets PERMISSION_DENIED', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo-no-storage');
  await page.getByRole('button', { name: 'Load' }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  // The manifest omits `storage`, so storage.set/get must be denied even
  // though the method names are real and the request is otherwise valid.
  await expect(frame.locator('#storage-result')).toHaveText(/^error:/, { timeout: 10_000 });
  // user is granted, so it still succeeds — proves denial is namespace-specific.
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');
});
