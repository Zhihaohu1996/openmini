import { expect, test } from '@playwright/test';

test('the Mini App iframe sandbox attribute is exactly "allow-scripts"', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const iframe = page.locator('[data-testid="miniapp-container"] iframe');
  await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
});
