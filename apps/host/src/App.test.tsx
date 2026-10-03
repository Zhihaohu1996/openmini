import { TRUST_CONFIG_FILENAME } from '@openmini/shared';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

describe('App', () => {
  it('is a component function', () => {
    expect(typeof App).toBe('function');
  });
});

describe('App remote "load by URL" control', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  /**
   * A fake Response.
   *
   * `arrayBuffer` is required because the loader reads the manifest with
   * `captureBytes` — its digest has to be computed over the bytes that were
   * served — so a mock implementing only `text()` no longer models the part
   * of the Response API the loader uses.
   */
  function fakeResponse(text: string, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
      arrayBuffer: () => {
        const bytes = new TextEncoder().encode(text);
        return Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
      },
    };
  }

  const REGISTERED_ID = 'com.openmini.registered';
  const PUBLIC_KEY =
    'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu5el220Y9BqnQsr/xLSeWOU0w/pZcdAqU+b+xcSG/pq/HlLuMho6QEur8bUoU2HuLrOLutm9GFq8hdDAYwwwUg==';

  /**
   * A trust configuration the host will accept. Phase 11 W6 made the host
   * fetch one at startup, so every test here has to answer that request —
   * and answering it with something unusable is now itself a scenario, not
   * an oversight.
   */
  const TRUST_CONFIG = JSON.stringify({
    trustConfigVersion: 1,
    packages: { [REGISTERED_ID]: { keys: [{ publicKey: PUBLIC_KEY, status: 'active' }] } },
  });

  function manifestFor(id: string): string {
    return JSON.stringify({
      schemaVersion: 1,
      id,
      name: 'Hello Remote',
      version: '0.1.0',
      entry: 'index.html',
      permissions: [],
    });
  }

  /**
   * Routes the three requests the app makes: the trust configuration at
   * startup, the package manifest, and its signature.
   */
  function mockFetch(options: {
    trustConfig?: string | null;
    manifest?: string;
    manifestStatus?: number;
  }) {
    global.fetch = vi.fn().mockImplementation((url: URL | string) => {
      const href = url.toString();
      if (href.endsWith(TRUST_CONFIG_FILENAME)) {
        return Promise.resolve(
          options.trustConfig === null
            ? fakeResponse('', 404)
            : fakeResponse(options.trustConfig ?? TRUST_CONFIG),
        );
      }
      if (href.endsWith('openmini.sig.json')) {
        // An unsigned package on a static host.
        return Promise.resolve(fakeResponse('', 404));
      }
      return Promise.resolve(
        fakeResponse(
          options.manifest ?? manifestFor('com.openmini.hello-remote'),
          options.manifestStatus,
        ),
      );
    }) as unknown as typeof fetch;
  }

  const loadByUrl = (value = 'http://localhost:5173/miniapps/hello-remote') => {
    fireEvent.change(screen.getByLabelText('Mini App package URL'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Load by URL' }));
  };

  const trustReady = () => screen.findByTestId('trust-config-status');

  it('renders MiniAppHost with the fetched manifest on success', async () => {
    mockFetch({});

    render(<App />);
    await trustReady();
    loadByUrl();

    expect((await screen.findAllByTestId('miniapp-status')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('remote-load-error')).toBeNull();
  });

  it('shows the fetch-failure reason and does not render MiniAppHost on failure', async () => {
    mockFetch({ manifestStatus: 404, manifest: '' });

    render(<App />);
    await trustReady();
    loadByUrl('http://localhost:5173/miniapps/missing');

    const errorEl = await screen.findByTestId('remote-load-error');
    expect(errorEl.textContent).toMatch(/manifest fetch failed \(404\)/);
  });

  it('reports the trust configuration it is running with', async () => {
    mockFetch({});

    render(<App />);

    // Waited for rather than read once: the first render of this element is
    // the "reading..." state, which deliberately carries no attribute.
    await waitFor(() => {
      expect(screen.getByTestId('trust-config-status').getAttribute('data-trust-config')).toBe(
        'ready',
      );
    });
    expect(screen.getByTestId('trust-config-status').textContent).toContain('1 registered id');
  });
});

/**
 * Phase 11 W6's central claim. A host with no usable trust configuration
 * must refuse the URL load path, and must not carry on with an empty store:
 * an empty store registers no ids, so nothing fails closed, and an impostor
 * of a registered id would load as merely unverified.
 */
describe('App with no usable trust configuration', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    cleanup();
  });

  const REGISTERED_ID = 'com.openmini.registered';

  function fakeResponse(text: string, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: () => Promise.resolve(text),
      arrayBuffer: () => {
        const bytes = new TextEncoder().encode(text);
        return Promise.resolve(
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        );
      },
    };
  }

  /**
   * Serves a broken trust config, and a package claiming a *registered* id
   * with no signature at all.
   *
   * That pairing is the point. With a working configuration this package is
   * refused outright -- it claims a registered id and is unsigned. If the
   * host fell back to an empty store it would load, reported as merely
   * unsigned, and the operator would see a running Mini App where they
   * should have seen a refusal.
   */
  function mockBrokenTrustConfig(trustConfigBody: string, status = 200): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn().mockImplementation((url: URL | string) => {
      const href = url.toString();
      if (href.endsWith(TRUST_CONFIG_FILENAME)) {
        return Promise.resolve(fakeResponse(trustConfigBody, status));
      }
      if (href.endsWith('openmini.sig.json')) {
        return Promise.resolve(fakeResponse('', 404));
      }
      return Promise.resolve(
        fakeResponse(
          JSON.stringify({
            schemaVersion: 1,
            id: REGISTERED_ID,
            name: 'Impostor',
            version: '0.1.0',
            entry: 'index.html',
            permissions: [],
          }),
        ),
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  it('says why the load path is disabled instead of failing silently', async () => {
    mockBrokenTrustConfig('{ "trustConfigVersion": 99, "packages": {} }');

    render(<App />);

    const error = await screen.findByTestId('trust-config-error');
    expect(error.getAttribute('data-trust-config')).toBe('unavailable');
    expect(error.textContent).toContain('disabled');
    expect(error.textContent).toContain('unsupported trustConfigVersion');
  });

  it('disables the URL input and the Load button', async () => {
    mockBrokenTrustConfig('', 404);

    render(<App />);
    await screen.findByTestId('trust-config-error');

    expect((screen.getByLabelText('Mini App package URL') as HTMLInputElement).disabled).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Load by URL' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('does not load a package even when the form is submitted anyway', async () => {
    // The button being disabled is a courtesy; the refusal has to be in the
    // handler. Submitting the form directly bypasses the button entirely,
    // which is what a determined operator -- or a stray Enter key -- does.
    const fetchMock = mockBrokenTrustConfig('not json at all');

    render(<App />);
    await screen.findByTestId('trust-config-error');
    const callsAfterStartup = fetchMock.mock.calls.length;

    const input = screen.getByLabelText('Mini App package URL');
    fireEvent.change(input, { target: { value: 'http://localhost:5173/miniapps/impostor' } });
    fireEvent.submit(input.closest('form') as HTMLFormElement);

    // Nothing was fetched: the package was never even requested, let alone
    // loaded unverified. This is the assertion that bites -- substituting an
    // empty trust store here fetches the manifest and the signature and
    // renders the impostor as merely unsigned.
    expect(fetchMock.mock.calls.length).toBe(callsAfterStartup);

    // Checked after the event loop has had every chance to settle, so a
    // host that *did* load would have appeared by now rather than this
    // passing because the assertion ran first.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByTestId('remote-miniapp-host')).toBeNull();
    expect(fetchMock.mock.calls.length).toBe(callsAfterStartup);
  });

  it('never renders a Mini App host while the configuration is unusable', async () => {
    mockBrokenTrustConfig('{}');

    render(<App />);
    await screen.findByTestId('trust-config-error');

    expect(screen.queryByTestId('remote-miniapp-host')).toBeNull();
    expect(screen.queryByTestId('miniapp-provenance')).toBeNull();
  });
});
