import { expect, test } from '@playwright/test';

test('an invalid manifest is rejected before any sandbox/iframe is created', async ({ page }) => {
  await page.goto('/?scenario=invalid-manifest');

  await expect(page.getByTestId('miniapp-status')).toHaveText(/manifest invalid/);
  await expect(page.getByRole('button', { name: 'Load', exact: true })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});
