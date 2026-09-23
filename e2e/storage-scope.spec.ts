import { expect, test, type FrameLocator, type Page } from '@playwright/test';

/**
 * Phase 10 storage scoping, in a real browser against real IndexedDB.
 *
 * These specs exist because nothing else could prove the phase. The Phase 9
 * signed fixtures carry no script and so cannot reach the bridge; the
 * `bridge-demo` fixture can, but the host renders it through `?scenario=`,
 * which supplies no provenance and therefore lands in the *embedded* tier —
 * the one tier Phase 10 deliberately leaves alone. A suite that passed only
 * through that path would be no evidence at all.
 *
 * So these drive `storage-signed` and `storage-unsigned`: real
 * @openmini/sdk Mini Apps, built by the CLI's own `assembleEntryDocument`,
 * served from `public/miniapps/`, and therefore **loaded by URL with real
 * provenance**. Every read and write below goes through the real dispatcher
 * into the host's real IndexedDB.
 *
 * `storage-signed`'s id is registered in the generated trust config and it is
 * signed by that key, so it reaches the verified tier. `storage-unsigned`'s
 * id is deliberately unregistered, so it stays origin-bound.
 */

const HOST_ORIGIN = 'http://localhost:5173';
const OTHER_ORIGIN = 'http://localhost:5174';

const DB_NAME = 'openmini-storage';
const STORE = 'entries';

/** Loads a package by URL and boots its sandbox, returning the Mini App frame. */
async function loadAndBoot(page: Page, packageUrl: string): Promise<FrameLocator> {
  await page.getByLabel('Mini App package URL').fill(packageUrl);
  await page.getByRole('button', { name: 'Load by URL' }).click();

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
  frame.locator('body').evaluate(
    (_el, k) =>
      (
        window as unknown as {
          __storageProbe: { get(a: string): Promise<string | null> };
        }
      ).__storageProbe.get(k as string),
    key,
  );

/** Reads the host origin's real IndexedDB directly, to prove *where* data landed. */
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

/** Seeds a scope directly, standing in for data an earlier release wrote. */
async function seedScope(
  page: Page,
  scope: string,
  entries: Record<string, string>,
): Promise<void> {
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

const SIGNED_ID = 'com.openmini.storage-signed';
const UNSIGNED_ID = 'com.openmini.storage-unsigned';

test.describe('verified packages use the verified-id scope', () => {
  test('a registered, signed package stores under v1:id:<id> in real IndexedDB', async ({
    page,
  }) => {
    await page.goto('/');
    const frame = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);

    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'true');
    await expect(page.getByTestId('miniapp-storage-scope')).toHaveAttribute(
      'data-tier',
      'verified',
    );

    await probeSet(frame, 'token', 'verified-value');
    expect(await probeGet(frame, 'token')).toBe('verified-value');

    // The assertion that matters: the bytes are in the verified namespace,
    // and in neither the origin-bound nor the bare/legacy one.
    expect(await readScope(page, `v1:id:${SIGNED_ID}`)).toEqual({ token: 'verified-value' });
    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${SIGNED_ID}`)).toEqual({});
    expect(await readScope(page, SIGNED_ID)).toEqual({});
  });
});

test.describe('unverified packages are origin-bound', () => {
  test('an unregistered, unsigned package stores under v1:origin:<origin>|<id>', async ({
    page,
  }) => {
    await page.goto('/');
    const frame = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-unsigned`);

    await expect(page.getByTestId('miniapp-provenance')).toHaveAttribute('data-verified', 'false');
    await expect(page.getByTestId('miniapp-storage-scope')).toHaveAttribute('data-tier', 'origin');

    await probeSet(frame, 'note', 'origin-value');

    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${UNSIGNED_ID}`)).toEqual({
      note: 'origin-value',
    });
    // Not in the verified namespace, and not in the bare/legacy one either.
    expect(await readScope(page, `v1:id:${UNSIGNED_ID}`)).toEqual({});
    expect(await readScope(page, UNSIGNED_ID)).toEqual({});
  });
});

test.describe('cross-origin isolation', () => {
  test('the same id served from two origins gets two separate stores', async ({ page }) => {
    // The documented leak, exercised for real: one package, one id, two
    // origins. Before Phase 10 the second would have read the first's data.
    // Two *paths* on one origin would still collide by design, so this needs
    // a genuinely different origin — hence the port-5174 server.
    await page.goto('/');
    const first = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-unsigned`);
    await probeSet(first, 'secret', 'belongs-to-5173');

    await page.goto('/');
    const impostor = await loadAndBoot(page, `${OTHER_ORIGIN}/miniapps/storage-unsigned`);

    expect(await probeGet(impostor, 'secret')).toBeNull();

    await probeSet(impostor, 'secret', 'belongs-to-5174');

    // Two distinct namespaces in one real database, neither overwriting the
    // other.
    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${UNSIGNED_ID}`)).toEqual({
      secret: 'belongs-to-5173',
    });
    expect(await readScope(page, `v1:origin:${OTHER_ORIGIN}|${UNSIGNED_ID}`)).toEqual({
      secret: 'belongs-to-5174',
    });
  });
});

test.describe('migration and adoption', () => {
  test('a package that becomes verified carries its origin-tier data forward', async ({ page }) => {
    await page.goto('/');
    // Stand in for the release before this one: the package was unsigned, so
    // its data is in the origin-bound namespace.
    await seedScope(page, `v1:origin:${HOST_ORIGIN}|${SIGNED_ID}`, {
      carried: 'from the unsigned era',
    });

    const frame = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);

    const scopeLine = page.getByTestId('miniapp-storage-scope');
    await expect(scopeLine).toHaveAttribute('data-tier', 'verified');
    await expect(scopeLine).toContainText('carried 1 entry');
    // Inherited data is not attested by the signature, and the host says so.
    await expect(scopeLine).toContainText('not attested');

    expect(await probeGet(frame, 'carried')).toBe('from the unsigned era');

    // Copied, never moved: a rollback to a pre-Phase-10 host must still find
    // its data where it left it.
    expect(await readScope(page, `v1:origin:${HOST_ORIGIN}|${SIGNED_ID}`)).toEqual({
      carried: 'from the unsigned era',
    });
  });

  test('does not re-adopt on a later load, and keeps writes made after adoption', async ({
    page,
  }) => {
    await page.goto('/');
    await seedScope(page, `v1:origin:${HOST_ORIGIN}|${SIGNED_ID}`, { shared: 'original' });

    const first = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);
    await probeSet(first, 'shared', 'written after adoption');

    // Reload: a second adoption would clobber the write above with the stale
    // source value.
    await page.goto('/');
    const second = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);

    await expect(page.getByTestId('miniapp-storage-scope')).toContainText('previously migrated');
    expect(await probeGet(second, 'shared')).toBe('written after adoption');
  });

  test('leaves bare legacy data alone, because this host has not opted in', async ({ page }) => {
    // Bare-id bytes were writable by any package at any origin, so they have
    // no trustworthy writer. Adoption requires an explicit host opt-in, and
    // this host gives none.
    await page.goto('/');
    await seedScope(page, SIGNED_ID, { legacy: 'possibly-poisoned' });

    const frame = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);

    await expect(page.getByTestId('miniapp-storage-scope')).toContainText('legacy-not-opted-in');
    expect(await probeGet(frame, 'legacy')).toBeNull();
    // And it is still sitting there, untouched.
    expect(await readScope(page, SIGNED_ID)).toEqual({ legacy: 'possibly-poisoned' });
  });
});

test.describe('real persistence', () => {
  test('verified-scope data survives a full page reload', async ({ page }) => {
    await page.goto('/');
    const first = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);
    await probeSet(first, 'durable', 'still here');

    await page.reload();
    const second = await loadAndBoot(page, `${HOST_ORIGIN}/miniapps/storage-signed`);

    expect(await probeGet(second, 'durable')).toBe('still here');
  });
});
