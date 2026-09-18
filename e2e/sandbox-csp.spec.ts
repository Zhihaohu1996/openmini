import { expect, test } from '@playwright/test';

test('the Mini App document enforces its CSP: no unsafe script sources, network blocked', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="miniapp-container"] iframe');

  // The inline bootstrap script executed at all only because its exact hash
  // is allow-listed in script-src — this exercises that the CSP is being
  // enforced, not merely declared.
  await expect(frame.locator('#hello')).toHaveText('Hello from OpenMini Sandbox');

  // connect-src 'none' blocks the fixture's own fetch() call.
  await expect(frame.locator('#connect-check')).toHaveText('blocked', { timeout: 10_000 });

  const cspContent = await frame
    .locator('meta[http-equiv="Content-Security-Policy"]')
    .getAttribute('content');
  expect(cspContent).toBeTruthy();
  expect(cspContent).toMatch(/script-src 'sha256-[A-Za-z0-9+/]+=*'/);
  expect(cspContent?.toLowerCase()).not.toContain('unsafe-inline');
  expect(cspContent?.toLowerCase()).not.toContain('unsafe-eval');
  expect(cspContent).not.toContain("'self'");
  expect(cspContent).toContain("connect-src 'none'");
  expect(cspContent).toContain("object-src 'none'");
  expect(cspContent).toContain("frame-src 'none'");
});
