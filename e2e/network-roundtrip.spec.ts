import { expect, test } from '@playwright/test';

type NetworkAttempt =
  | { ok: true; status: number; body: string }
  | { ok: false; code: string; message: string };

type NetworkHooksWindow = {
  __bridgeDemo: {
    networkFetch(url: string): Promise<NetworkAttempt>;
    directFetch(url: string): Promise<string>;
  };
};

async function loadNetworkDemo(page: import('@playwright/test').Page) {
  await page.goto('/?scenario=bridge-demo-network');
  await page.getByRole('button', { name: 'Load', exact: true }).click();
  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });
  return frame;
}

test('an allowlisted cross-origin request round-trips through the host bridge', async ({ page }) => {
  const frame = await loadNetworkDemo(page);

  // Port 5174 is a genuinely different origin from the :5173 host page, and
  // this endpoint returns the CORS headers that requires.
  const attempt = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.networkFetch('http://localhost:5174/test-api/echo'),
  );

  expect(attempt).toMatchObject({ ok: true, status: 200, body: 'echo-ok' });
  await expect(frame.locator('#network-result')).toHaveText('200:echo-ok');
});

test('a host outside the manifest allowlist is denied', async ({ page }) => {
  const frame = await loadNetworkDemo(page);

  const attempt = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.networkFetch('https://blocked.example.com/data'),
  );

  expect(attempt).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
});

test('a Mini App without the network permission cannot call network.fetch at all', async ({ page }) => {
  // The bridge-demo manifest grants storage/navigation/user but not network.
  await page.goto('/?scenario=bridge-demo');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');
  await expect(frame.locator('#storage-result')).toHaveText('hello from bridge', { timeout: 10_000 });

  const attempt = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.networkFetch('http://localhost:5173/test-api/echo'),
  );

  expect(attempt).toMatchObject({ ok: false, code: 'PERMISSION_DENIED' });
});

test('the sandbox CSP still blocks the Mini App from fetching directly', async ({ page }) => {
  const frame = await loadNetworkDemo(page);

  // Granting the network permission must not relax connect-src: the
  // host-mediated bridge call is the only way out, even for an allowlisted
  // host the Mini App could reach through network.fetch.
  const direct = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.directFetch('http://localhost:5173/test-api/echo'),
  );

  expect(direct).toMatch(/^blocked:/);
});

test('the host aborts a response over its own size cap', async ({ page }) => {
  const frame = await loadNetworkDemo(page);

  // The /large endpoint understates its Content-Length, so passing this
  // proves the cap counts bytes actually read rather than trusting a header.
  const oversized = await frame.locator('body').evaluate(() =>
    (window as unknown as NetworkHooksWindow).__bridgeDemo.networkFetch('http://localhost:5173/test-api/large'),
  );

  expect(oversized).toMatchObject({ ok: false, code: 'NETWORK_RESPONSE_TOO_LARGE' });
});
