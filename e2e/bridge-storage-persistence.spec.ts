import { expect, test } from '@playwright/test';

test('openmini.storage.* persists across a real destroy -> reload cycle', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });

  // Store a value under a different key than the fixture's own greeting, to
  // isolate this assertion from the fixture's own set/get round trip.
  await frame.locator('body').evaluate(() =>
    (
      window as unknown as { __bridgeDemo: { setPersistedValue(key: string, value: string): Promise<void> } }
    ).__bridgeDemo.setPersistedValue('persist-key', 'still here after reload'),
  );

  await page.getByRole('button', { name: 'Destroy' }).click();
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed');

  // Recreate the sandbox for the same Mini App (same manifest id) and read
  // the value back without ever setting it again — proving it survived the
  // real destroy/recreate cycle via the persistent IndexedDB-backed provider,
  // not just the in-session round trip bridge-roundtrip.spec.ts covers.
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const frameAfterReload = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frameAfterReload.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });

  const persistedValue = await frameAfterReload.locator('body').evaluate(() =>
    (window as unknown as { __bridgeDemo: { getPersistedValue(key: string): Promise<string | null> } }).__bridgeDemo.getPersistedValue(
      'persist-key',
    ),
  );
  expect(persistedValue).toBe('still here after reload');
});
