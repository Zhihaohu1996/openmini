import { expect, test } from '@playwright/test';

/**
 * The previous title said the forged request "is dropped, not crashed on or
 * answered". Two of those three were never asserted, and the third was simply
 * false: the dispatcher answers a session mismatch with `SESSION_INVALID`
 * (docs/security/bridge.md), it does not stay silent. Silence is reserved for
 * *malformed* envelopes, where replying would give an attacker an oracle; a
 * well-formed request with the wrong session is a different case.
 */
test('a forged request with a spoofed sessionId is answered SESSION_INVALID, and the host stays up', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  await expect(frame.locator('#user-result')).toHaveText('{"id":null,"displayName":null}');

  // Sent from inside the sandboxed script, over the real port.
  const reply = await frame.locator('body').evaluate(() =>
    (
      window as unknown as {
        __bridgeDemo: {
          sendForgedSession(): Promise<
            { kind: 'error'; code: string } | { kind: 'success' } | { kind: 'timed-out' }
          >;
        };
      }
    ).__bridgeDemo.sendForgedSession(),
  );

  // The documented reply, asserted rather than assumed. `timed-out` would
  // mean the host went silent; `success` would mean the forged session was
  // honoured, which is the failure this test exists to catch.
  expect(reply).toEqual({ kind: 'error', code: 'SESSION_INVALID' });

  // Still alive and responsive: a legitimate command afterward still works.
  await page.getByRole('button', { name: 'Destroy' }).click();
  await expect(page.getByTestId('miniapp-status')).toHaveText('status: destroyed');

  // "not crashed on", asserted instead of implied.
  expect(pageErrors).toEqual([]);
});
