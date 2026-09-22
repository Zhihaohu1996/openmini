import { expect, test } from '@playwright/test';

/**
 * Package verification, in a real browser, against really-signed packages.
 *
 * The unit suites cover the decision table on values; these five run it end
 * to end — real WebCrypto, real fetches, real fixtures signed at build time
 * by an ephemeral P-256 key (see apps/host/scripts/build-signed-fixtures.ts).
 * That matters here more than usual: the digest agreement this phase depends
 * on is between Node, which signs, and the browser, which verifies, and no
 * in-process test puts both of those on the same bytes.
 *
 * Five scenarios: the three identity outcomes a load can report (verified,
 * untrusted-key, unsigned), the registered-but-unsigned refusal, and a
 * tampered package — which is not an identity outcome at all but a
 * resource-digest failure, and so exercises a different check from the other
 * four. Two of the five are refusals that must not become "loaded but
 * flagged", and two are successes that must not become refusals.
 *
 * The remaining table row in docs/security/integrity.md — a signature that
 * is present but does not verify — is covered by unit tests rather than
 * here, since producing one needs a corrupted envelope rather than a
 * buildable fixture.
 */

const BASE = 'http://localhost:5173/miniapps';

async function loadByUrl(page: import('@playwright/test').Page, name: string): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Mini App package URL').fill(`${BASE}/${name}`);
  await page.getByRole('button', { name: 'Load by URL' }).click();
}

test('a signed package from a registered key loads and reports itself verified', async ({
  page,
}) => {
  await loadByUrl(page, 'signed-trusted');

  const host = page.getByTestId('remote-miniapp-host');
  await expect(host).toHaveCount(1);

  const provenance = host.getByTestId('miniapp-provenance');
  await expect(provenance).toHaveAttribute('data-verified', 'true');
  await expect(provenance).toHaveText(/verified/);

  // And it actually runs: verification gates the load, it does not replace it.
  await host.getByRole('button', { name: 'Load' }).click();
  await expect(host.getByTestId('miniapp-status')).toHaveText(/ready|running/, {
    timeout: 10_000,
  });
});

test('a tampered entry document is refused even though its signature is genuine', async ({
  page,
}) => {
  // The realistic attack. The signature verifies — it was produced by the
  // trusted key over the real payload — but the bytes being served are no
  // longer the bytes it covers. Only the per-resource digest check sees this,
  // and it must refuse rather than load-and-warn.
  await loadByUrl(page, 'tampered');

  const host = page.getByTestId('remote-miniapp-host');
  await host.getByRole('button', { name: 'Load' }).click();

  await expect(host.getByTestId('miniapp-status')).toHaveText(/status: error/, {
    timeout: 10_000,
  });
  // The injected script must never have run.
  expect(
    await page.evaluate(() => (window as unknown as { pwned?: boolean }).pwned),
  ).toBeUndefined();
});

test('a registered id with no signature at all is refused, not downgraded', async ({ page }) => {
  // The anti-downgrade case. If stripping a signature were a route to the
  // weaker unsigned path, every other check in the chain would be optional:
  // an attacker would simply delete the file.
  await loadByUrl(page, 'unsigned-trusted');

  await expect(page.getByTestId('remote-load-error')).toHaveText(/registered.*unsigned/s);
  await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('an unregistered id signed by an unknown key loads, but not as verified', async ({ page }) => {
  // The host has expressed no opinion about who owns this id, so there is
  // nothing to fail closed against — but "somebody signed this" is not
  // "somebody we trust signed this", and the UI must not conflate them.
  await loadByUrl(page, 'signed-untrusted');

  const provenance = page.getByTestId('remote-miniapp-host').getByTestId('miniapp-provenance');
  await expect(provenance).toHaveAttribute('data-verified', 'false');
  await expect(provenance).toHaveText(/untrusted key/);
});

test('an unregistered id with no signature still loads, reported as unsigned', async ({ page }) => {
  // hello-styled is the Phase 8 artifact, unsigned and unregistered. It has
  // to keep working: this phase adds verification, it does not quietly make
  // unsigned packages unloadable.
  await loadByUrl(page, 'hello-styled');

  const host = page.getByTestId('remote-miniapp-host');
  await expect(host).toHaveCount(1);

  const provenance = host.getByTestId('miniapp-provenance');
  await expect(provenance).toHaveAttribute('data-verified', 'false');
  await expect(provenance).toHaveText(/unsigned/);

  await host.getByRole('button', { name: 'Load' }).click();
  await expect(host.getByTestId('miniapp-status')).toHaveText(/ready|running/, {
    timeout: 10_000,
  });
});
