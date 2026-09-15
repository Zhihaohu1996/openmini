import { expect, test } from '@playwright/test';

test('navigation.close() resolves before the sandbox is torn down (ack-confirmed, real browser)', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load' }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');

  const closeOutcome = await frame.locator('body').evaluate(() =>
    (window as unknown as { __bridgeDemo: { closeAndReport(): Promise<'resolved' | 'rejected'> } }).__bridgeDemo.closeAndReport(),
  );

  // The Mini App's own call resolved successfully...
  expect(closeOutcome).toBe('resolved');
  // ...and only afterward does the host actually tear the sandbox down —
  // proving destroy() waited for the close-ack round-trip rather than
  // racing a timer against message delivery.
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed', { timeout: 10_000 });
  await expect(page.locator('[data-testid="miniapp-container"] iframe')).toHaveCount(0);
});
