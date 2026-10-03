import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/**
 * Phase 11 trust lifecycle, in a real browser.
 *
 * The unit suites decide the policy on values and the host suites decide the
 * React wiring on mocks. Neither can show the thing this phase actually
 * claims: that a key an operator retired in a JSON file stops a real package
 * loading over a real network into a real sandbox, and that rotating to a
 * successor leaves the app's real IndexedDB data exactly where it was.
 *
 * So every case here goes through the host's own "Load by URL" control
 * against packages served from `public/miniapps/`, signed at fixture-build
 * time by ephemeral keys, and registered through the same
 * `openmini.trust.json` the host fetches at startup. That matters for the
 * same reason Phase 10 recorded: a `?scenario=` fixture carries no
 * provenance, so it proves nothing about this layer.
 *
 * The fixtures (see apps/host/scripts/build-signed-fixtures.ts):
 *
 *   revoked-key      registered, its only key revoked, signed by it
 *   storage-rotated  registered with the retired key revoked and a
 *                    successor active, signed by the successor
 */

const HOST_ORIGIN = 'http://localhost:5173';

const REVOKED_ID = 'com.openmini.revoked-key';
const ROTATED_ID = 'com.openmini.storage-rotated';

const DB_NAME = 'openmini-storage';
const STORE = 'entries';

async function loadByUrl(page: Page, name: string): Promise<void> {
  await page.getByLabel('Mini App package URL').fill(`${HOST_ORIGIN}/miniapps/${name}`);
  await page.getByRole('button', { name: 'Load by URL' }).click();
}

/** Loads a storage-probe package and boots its sandbox. */
async function loadAndBoot(page: Page, name: string): Promise<FrameLocator> {
  await loadByUrl(page, name);

  const host = page.getByTestId('remote-miniapp-host');
  await expect(host).toHaveCount(1);
  await host.getByRole('button', { name: 'Load', exact: true }).click();

  const frame = page.frameLocator('[data-testid="remote-miniapp-host"] iframe');
  await expect(frame.locator('#probe-ready')).toHaveText('ready', { timeout: 15_000 });
  return frame;
}

const probeSet = (frame: FrameLocator, key: string, value: string) =>
  frame
    .locator('body')
    .evaluate(
      (_el, [k, v]) =>
        (
          window as unknown as { __storageProbe: { set(a: string, b: string): Promise<void> } }
        ).__storageProbe.set(k as string, v as string),
      [key, value],
    );

const probeGet = (frame: FrameLocator, key: string) =>
  frame
    .locator('body')
    .evaluate(
      (_el, k) =>
        (
          window as unknown as { __storageProbe: { get(a: string): Promise<string | null> } }
        ).__storageProbe.get(k as string),
      key,
    );

/** Reads the host origin's real IndexedDB directly, to prove *where* data is. */
async function readScope(page: Page, scope: string): Promise<Record<string, string>> {
  return page.evaluate(
    ([dbName, storeName, appId]) =>
      new Promise<Record<string, string>>((resolve, reject) => {
        const open = indexedDB.open(dbName as string);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName as string)) {
            resolve({});
            return;
          }
          const index = db
            .transaction(storeName as string, 'readonly')
            .objectStore(storeName as string)
            .index('byAppId');
          const request = index.getAll(IDBKeyRange.only(appId as string));
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const out: Record<string, string> = {};
            for (const row of request.result as { key: string; value: string }[]) {
              out[row.key] = row.value;
            }
            resolve(out);
          };
        };
      }),
    [DB_NAME, STORE, scope],
  );
}

/** Seeds a scope directly, standing in for what an earlier release wrote. */
async function seedScope(page: Page, scope: string, entries: Record<string, string>) {
  await page.evaluate(
    ([dbName, storeName, appId, rows]) =>
      new Promise<void>((resolve, reject) => {
        const open = indexedDB.open(dbName as string, 1);
        open.onerror = () => reject(open.error);
        open.onupgradeneeded = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains(storeName as string)) {
            const store = db.createObjectStore(storeName as string, { keyPath: ['appId', 'key'] });
            store.createIndex('byAppId', 'appId', { unique: false });
          }
        };
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(storeName as string, 'readwrite');
          const store = tx.objectStore(storeName as string);
          for (const [key, value] of Object.entries(rows as Record<string, string>)) {
            store.put({ appId: appId as string, key, value });
          }
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        };
      }),
    [DB_NAME, STORE, scope, entries],
  );
}

test.describe('a revoked key is refused, and refused as revoked', () => {
  test('the host names the revoked state rather than calling the key untrusted', async ({
    page,
  }) => {
    await page.goto('/');
    await loadByUrl(page, 'revoked-key');

    const error = page.getByTestId('remote-load-error');
    // The code, not the prose. Three refusals with three remedies, and the
    // host has to tell them apart without reading the sentence.
    await expect(error).toHaveAttribute('data-refusal-code', 'revoked-key');

    // And it must not be reported as either of the other two.
    await expect(error).not.toHaveAttribute('data-refusal-code', 'untrusted-key');
    await expect(error).not.toHaveAttribute('data-refusal-code', 'unsigned-registered');
    await expect(error).toContainText('revoked');
  });

  test('tells the operator to re-sign rather than to re-trust the key', async ({ page }) => {
    // The remedy is the whole reason the two are kept apart. Re-registering
    // a revoked key would undo a decision somebody made deliberately.
    await page.goto('/');
    await loadByUrl(page, 'revoked-key');

    await expect(page.getByTestId('remote-load-error')).toContainText('undo the revocation');
  });

  test('creates no sandbox at all, so nothing of the package ever runs', async ({ page }) => {
    // Refused, not loaded-and-flagged. A revoked key that downgraded to the
    // unverified path would still execute, in the shared origin storage
    // tier -- which is the downgrade this phase exists to prevent.
    await page.goto('/');
    await loadByUrl(page, 'revoked-key');

    await expect(page.getByTestId('remote-load-error')).toBeVisible();
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    await expect(page.getByTestId('miniapp-provenance')).toHaveCount(0);
    await expect(page.getByTestId('miniapp-storage-scope')).toHaveCount(0);
  });
});

test.describe('rotation keeps the verified namespace', () => {
  test('a package signed by the successor loads verified', async ({ page }) => {
    await page.goto('/');
    await loadAndBoot(page, 'storage-rotated');

    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'true');
    await expect(page.getByTestId('miniapp-storage-scope')).toHaveAttribute(
      'data-tier',
      'verified',
    );
  });

  test('reads the verified-namespace data the retired key left behind', async ({ page }) => {
    // The continuity claim, against real IndexedDB. The seeded bytes stand
    // in for what this app wrote while the now-retired key was still
    // active; they are in `v1:id:<id>` because that namespace names the id
    // and never the signing key. If rotation moved the namespace, the
    // successor would start empty -- turning routine key hygiene into a
    // data-loss event.
    await page.goto('/');
    await seedScope(page, `v1:id:${ROTATED_ID}`, { draft: 'written under the retired key' });

    const frame = await loadAndBoot(page, 'storage-rotated');

    expect(await probeGet(frame, 'draft')).toBe('written under the retired key');
    // Served in place, not copied in from somewhere: the app's own data was
    // already in the target, so nothing is adopted.
    await expect(page.getByTestId('miniapp-storage-scope')).toContainText('target-non-empty');
  });

  test('writes through the rotated identity into the id-named namespace', async ({ page }) => {
    // The other half: not just reading what was there, but continuing to
    // use the same namespace afterwards.
    await page.goto('/');
    const frame = await loadAndBoot(page, 'storage-rotated');
    await probeSet(frame, 'after', 'written under the successor');

    expect(await readScope(page, `v1:id:${ROTATED_ID}`)).toEqual({
      after: 'written under the successor',
    });
    // And nowhere else. A namespace derived from the signing key would have
    // landed somewhere that changes when the key does.
    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${ROTATED_ID}`)).toEqual({});
    expect(await readScope(page, ROTATED_ID)).toEqual({});
  });

  test('both keys agree on the namespace across a full reload', async ({ page }) => {
    await page.goto('/');
    await seedScope(page, `v1:id:${ROTATED_ID}`, { before: 'retired key era' });

    const first = await loadAndBoot(page, 'storage-rotated');
    await probeSet(first, 'after', 'successor era');

    await page.reload();
    const second = await loadAndBoot(page, 'storage-rotated');

    // One namespace, two eras of writes, nothing stranded by the rotation.
    expect(await probeGet(second, 'before')).toBe('retired key era');
    expect(await probeGet(second, 'after')).toBe('successor era');
  });
});

test.describe('revocation strands data rather than exposing it', () => {
  test('a revoked package cannot reach the verified-tier data it wrote', async ({ page }) => {
    await page.goto('/');
    // What this package wrote back when its key was trusted.
    await seedScope(page, `v1:id:${REVOKED_ID}`, { secret: 'written while trusted' });

    await loadByUrl(page, 'revoked-key');

    // Refused, so there is no sandbox to read it with and no scope was ever
    // derived. That is the only thing standing between the revoked package
    // and its old data -- and it is enough, because the refusal happens
    // before provenance exists.
    await expect(page.getByTestId('remote-load-error')).toHaveAttribute(
      'data-refusal-code',
      'revoked-key',
    );
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
    await expect(page.getByTestId('miniapp-storage-scope')).toHaveCount(0);

    // Stranded, not deleted. Phase 10 has no delete and Phase 11 adds none,
    // so re-registering the id restores access -- the data is unreachable,
    // which is a different thing from gone.
    expect(await readScope(page, `v1:id:${REVOKED_ID}`)).toEqual({
      secret: 'written while trusted',
    });
  });

  test('the refusal does not spill the data into a weaker namespace', async ({ page }) => {
    // If a revoked key downgraded to the unverified path, the package would
    // run in `v1:origin:...` -- a namespace any unsigned package at this
    // origin can also reach.
    await page.goto('/');
    await seedScope(page, `v1:id:${REVOKED_ID}`, { secret: 'written while trusted' });

    await loadByUrl(page, 'revoked-key');
    await expect(page.getByTestId('remote-load-error')).toBeVisible();

    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${REVOKED_ID}`)).toEqual({});
    expect(await readScope(page, REVOKED_ID)).toEqual({});
  });
});

test.describe('a host with no usable trust configuration refuses the URL path', () => {
  test('a missing configuration disables the control and says why', async ({ page }) => {
    await page.goto('/?trust=missing');

    const error = page.getByTestId('trust-config-error');
    await expect(error).toHaveAttribute('data-trust-config', 'unavailable');
    await expect(error).toContainText('disabled');
    await expect(error).toContainText('missing');

    await expect(page.getByLabel('Mini App package URL')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Load by URL' })).toBeDisabled();
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
  });

  test('an invalid configuration is reported with the validator own issue list', async ({
    page,
  }) => {
    await page.goto('/?trust=invalid');

    const error = page.getByTestId('trust-config-error');
    await expect(error).toContainText('Invalid openmini.trust.json');
    // The same text `openmini trust validate` prints, because it is the same
    // formatter over the same parser.
    await expect(error).toContainText('unsupported trustConfigVersion');
    await expect(error).toContainText('notAfter');

    await expect(page.getByRole('button', { name: 'Load by URL' })).toBeDisabled();
  });

  test('never falls back to an empty trust store, even under a forced submit', async ({ page }) => {
    // The failure this phase names explicitly. An empty store registers no
    // ids, so nothing fails closed: `unsigned-trusted` -- registered, and
    // shipped with no signature at all -- would load as merely unsigned
    // instead of being refused.
    //
    // Driven past the disabled control on purpose. The button is a
    // courtesy; the gate is in the submit handler, and only a forced submit
    // distinguishes the two.
    const packageRequests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/miniapps/')) {
        packageRequests.push(request.url());
      }
    });

    await page.goto('/?trust=invalid');
    await expect(page.getByTestId('trust-config-error')).toBeVisible();

    await page.evaluate((url) => {
      const input = document.querySelector<HTMLInputElement>(
        'input[aria-label="Mini App package URL"]',
      );
      if (!input) {
        throw new Error('the URL input is not in the document');
      }
      // Past both guards a real operator would hit: the disabled attribute,
      // and React's controlled value.
      input.disabled = false;
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setValue?.call(input, url);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.form?.requestSubmit();
    }, `${HOST_ORIGIN}/miniapps/unsigned-trusted`);

    // Nothing loaded, and nothing was even fetched: the handler refused
    // before reaching the network.
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
    await expect(page.locator('iframe')).toHaveCount(0);
    expect(packageRequests).toEqual([]);
  });

  test('the same package is refused -- not loaded -- when the configuration works', async ({
    page,
  }) => {
    // The control for the test above. With a usable configuration the host
    // does reach the package and does refuse it, by id and by code. Without
    // that contrast, "nothing happened" could mean the fixture was broken
    // rather than the trust store being in force.
    await page.goto('/');
    await expect(page.getByTestId('trust-config-status')).toHaveAttribute(
      'data-trust-config',
      'ready',
    );

    await loadByUrl(page, 'unsigned-trusted');

    await expect(page.getByTestId('remote-load-error')).toHaveAttribute(
      'data-refusal-code',
      'unsigned-registered',
    );
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);
  });

  test('refuses every package, not only the registered ones', async ({ page }) => {
    // "Refuses the URL load path" rather than "fails closed per id".
    // hello-styled is unregistered and unsigned, so an empty trust store
    // would load it exactly as the working host does -- which is precisely
    // why it is the package that shows the path itself is shut.
    await page.goto('/?trust=missing');
    await expect(page.getByTestId('trust-config-error')).toBeVisible();

    await expect(page.getByLabel('Mini App package URL')).toBeDisabled();
    await expect(page.getByTestId('remote-miniapp-host')).toHaveCount(0);

    // And it does load when the configuration is usable.
    await page.goto('/');
    await loadAndBootStatic(page, 'hello-styled');
  });
});

/** Boots an inert (script-free) fixture and confirms it reached the sandbox. */
async function loadAndBootStatic(page: Page, name: string): Promise<void> {
  await loadByUrl(page, name);
  const host = page.getByTestId('remote-miniapp-host');
  await expect(host).toHaveCount(1);
  await host.getByRole('button', { name: 'Load', exact: true }).click();
  await expect(host.getByTestId('miniapp-status')).toHaveText(/ready|running/, {
    timeout: 15_000,
  });
}
