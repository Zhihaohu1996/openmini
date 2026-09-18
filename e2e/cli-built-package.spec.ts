import { expect, test } from '@playwright/test';

/**
 * End-to-end proof that a package built by @openmini/cli is accepted by the
 * real runtime — including its inline styles.
 *
 * The style assertion is the point: CSP only applies a hashed <style> block
 * if the hash the builder computed matches what the browser computes over
 * that exact content. A wrong or missing hash shows up here as unstyled
 * text, so this fails loudly rather than silently degrading.
 */
test('a CLI-built package boots and its hashed inline styles are applied', async ({ page }) => {
  await page.goto('/');

  await page.getByLabel('Mini App package URL').fill('http://localhost:5173/miniapps/hello-styled');
  await page.getByRole('button', { name: 'Load by URL' }).click();

  const remoteHost = page.getByTestId('remote-miniapp-host');
  await expect(remoteHost.getByTestId('miniapp-status')).toHaveText('status: idle');

  await remoteHost.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(remoteHost.getByTestId('miniapp-status')).toHaveText('status: running', {
    timeout: 10_000,
  });

  const frame = remoteHost.frameLocator('iframe');
  const heading = frame.locator('#styled-heading');

  // The script ran, so the handshake completed inside a CLI-built document.
  await expect(heading).toHaveText('styled and connected');

  // ...and the browser actually applied the hashed inline <style>.
  await expect(heading).toHaveCSS('color', 'rgb(16, 128, 64)');
});

/**
 * Scoped to what an HTTP client can actually establish. It cannot enumerate
 * the package directory, so it cannot prove "exactly two files" — that claim
 * is asserted against the artifact on disk in
 * apps/host/src/miniapp/fixtures/packageArtifact.test.ts. What this *can*
 * prove is that both files the loader reads are served, and that the entry
 * document carries exactly one builder-generated CSP with both hash sources.
 */
test('a CLI-built package serves both loader files, with a single builder-generated CSP', async ({
  request,
}) => {
  const manifest = await request.get('http://localhost:5173/miniapps/hello-styled/openmini.json');
  expect(manifest.status()).toBe(200);
  expect(await manifest.json()).toMatchObject({
    id: 'com.openmini.hello-styled',
    entry: 'index.html',
  });

  const entry = await request.get('http://localhost:5173/miniapps/hello-styled/index.html');
  expect(entry.status()).toBe(200);

  const html = await entry.text();
  // The CLI owns the policy: exactly one, and it carries both hashes.
  expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
  expect(html).toMatch(/script-src 'sha256-/);
  expect(html).toMatch(/style-src 'sha256-/);
});
