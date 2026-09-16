import { expect, test } from '@playwright/test';

type NetworkAttempt =
  | { ok: true; status: number; body: string }
  | { ok: false; code: string; message: string };

type NetworkHooksWindow = {
  __bridgeDemo: { networkFetch(url: string): Promise<NetworkAttempt> };
};

/**
 * Converts the Fetch-Standard reading behind Phase 7's redirect policy into
 * a fact verified against real Chromium, checking the two properties the
 * design rests on separately:
 *
 *  (i) security — the redirect is never followed, so a request cannot be
 *      carried past the manifest allowlist. Asserted both by the target's
 *      distinctive content never reaching the Mini App and by the fixture
 *      server never recording a request for it.
 * (ii) classification — only what the browser genuinely exposes. A network
 *      error surfaces as a bare TypeError with no cause, so the host reports
 *      the generic NETWORK_REQUEST_FAILED rather than inventing a distinct
 *      redirect error it cannot actually detect.
 */
test('a redirect is never followed, and is reported only as a generic network failure', async ({
  page,
  request,
}) => {
  await page.goto('/?scenario=bridge-demo-network');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });

  const attempt = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.networkFetch(
      'http://localhost:5173/test-api/redirect',
    ),
  );

  // (ii) The host reports what it can actually know — no more.
  expect(attempt).toMatchObject({ ok: false, code: 'NETWORK_REQUEST_FAILED' });

  // (i) The redirect target's content never reached the Mini App...
  expect(JSON.stringify(attempt)).not.toContain('REDIRECT-TARGET-CONTENT');

  // ...and the server confirms it was never even requested. The counters are
  // process-wide and specs run in parallel, so this asserts the redirect was
  // genuinely attempted rather than an exact count — while /secret stays an
  // absolute check: no spec in the suite may ever cause it to be reached.
  const hits = (await (await request.get('http://localhost:5173/test-api/hits')).json()) as Record<string, number>;
  expect(hits['/redirect']).toBeGreaterThanOrEqual(1);
  expect(hits['/secret']).toBeUndefined();
});

test('a CORS-rejected request is reported with the same code as a blocked redirect', async ({ page }) => {
  await page.goto('/?scenario=bridge-demo-network');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });

  // Port 5174 is a different origin from the :5173 host page, so this is a
  // real cross-origin request; the endpoint deliberately omits CORS headers.
  // The manifest allowlists the host, which is necessary but not sufficient
  // — the allowlist is not a CORS bypass.
  const [redirectAttempt, corsAttempt] = await frame.locator('body').evaluate(() => {
    const hooks = (window as unknown as NetworkHooksWindow).__bridgeDemo;
    return Promise.all([
      hooks.networkFetch('http://localhost:5173/test-api/redirect'),
      hooks.networkFetch('http://localhost:5174/test-api/no-cors'),
    ]);
  });

  expect(corsAttempt).toMatchObject({ ok: false, code: 'NETWORK_REQUEST_FAILED' });
  expect(JSON.stringify(corsAttempt)).not.toContain('should-not-be-readable');
  // Pins the documented indistinguishability: two different causes, one code.
  expect((corsAttempt as { code: string }).code).toBe((redirectAttempt as { code: string }).code);
});
