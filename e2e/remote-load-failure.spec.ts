import { expect, test } from '@playwright/test';

test('a URL with no openmini.json behind it surfaces an error and never creates a sandbox', async ({
  page,
}) => {
  await page.goto('/');

  await page
    .getByLabel('Mini App package URL')
    .fill('http://localhost:5173/miniapps/does-not-exist');
  await page.getByRole('button', { name: 'Load by URL' }).click();

  await expect(page.getByTestId('remote-load-error')).toHaveText(/manifest fetch failed \(404\)/);
  await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});
