import { expect, test } from '@playwright/test';

test('the sandbox reaches running via the real MessageChannel handshake, and destroy/recreate works', async ({
  page,
}) => {
  await page.goto('/');
  const status = page.getByTestId('miniapp-status');

  await expect(status).toHaveText('status: idle');

  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(status).toHaveText('status: running', { timeout: 10_000 });

  await page.getByRole('button', { name: 'Destroy' }).click();
  await expect(status).toHaveText('status: destroyed');
  await expect(page.locator('[data-testid="miniapp-container"] iframe')).toHaveCount(0);

  // A fresh sandbox instance (new session, new MessageChannel) reaches
  // running again after destroy — the port/session are not reused.
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(status).toHaveText('status: running', { timeout: 10_000 });
});
