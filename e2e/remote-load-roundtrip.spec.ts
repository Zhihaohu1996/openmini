import { expect, test } from '@playwright/test';

test('loading a real static package by URL boots the Mini App through the existing sandbox pipeline', async ({
  page,
}) => {
  await page.goto('/');

  await page
    .getByLabel('Mini App package URL')
    .fill('http://localhost:5173/miniapps/hello-remote');
  await page.getByRole('button', { name: 'Load by URL' }).click();

  const remoteHost = page.getByTestId('remote-miniapp-host');
  const status = remoteHost.getByTestId('miniapp-status');
  await expect(status).toHaveText('status: idle');

  await remoteHost.getByRole('button', { name: 'Load' }).click();
  await expect(status).toHaveText('status: running', { timeout: 10_000 });
  await expect(remoteHost.locator('iframe')).toHaveCount(1);
});
