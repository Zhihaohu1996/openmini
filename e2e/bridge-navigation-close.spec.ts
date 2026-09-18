import { expect, test } from '@playwright/test';

test('navigation.close() resolves before the sandbox is torn down (ack-confirmed, real browser)', async ({
  page,
}) => {
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', {
    timeout: 10_000,
  });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');

  const closeOutcome = await frame.locator('body').evaluate(() =>
    (
      window as unknown as {
        __bridgeDemo: { closeAndReport(): Promise<'resolved' | 'rejected'> };
      }
    ).__bridgeDemo.closeAndReport(),
  );

  // The Mini App's own call resolved successfully...
  expect(closeOutcome).toBe('resolved');

  // ...and only afterward does the host tear the sandbox down.
  //
  // On its own, that ordering does not distinguish the ack path from the
  // 2000ms fallback timer, which also ends in a teardown — the title claimed
  // "ack-confirmed" while the assertions were consistent with either. Timing
  // is what separates them: an ack round-trip between two frames in the same
  // browser completes in milliseconds, so a teardown well inside the fallback
  // window can only have come from the ack.
  const teardownStart = Date.now();
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed', {
    timeout: 10_000,
  });
  const teardownMs = Date.now() - teardownStart;

  expect(teardownMs).toBeLessThan(1500);
  await expect(page.locator('[data-testid="miniapp-container"] iframe')).toHaveCount(0);
});
