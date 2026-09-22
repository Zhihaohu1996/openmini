import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

  it('renders MiniAppHost with the fetched manifest on success', async () => {
    const manifestJson = JSON.stringify({
      schemaVersion: 1,
      id: 'com.openmini.hello-remote',
      name: 'Hello Remote',
      version: '0.1.0',
      entry: 'index.html',
      permissions: [],
    });
    // The signature request 404s: an unsigned package on a static host.
    global.fetch = vi
      .fn()
      .mockImplementation((url: URL | string) =>
        Promise.resolve(
          url.toString().endsWith('openmini.sig.json')
            ? fakeResponse('', 404)
            : fakeResponse(manifestJson),
        ),
      ) as unknown as typeof fetch;

    render(<App />);
    fireEvent.change(screen.getByLabelText('Mini App package URL'), {
      target: { value: 'http://localhost:5173/miniapps/hello-remote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load by URL' }));

    expect((await screen.findAllByTestId('miniapp-status')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('remote-load-error')).toBeNull();
  });

  it('shows the fetch-failure reason and does not render MiniAppHost on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue(fakeResponse('', 404)) as unknown as typeof fetch;

    render(<App />);
    fireEvent.change(screen.getByLabelText('Mini App package URL'), {
      target: { value: 'http://localhost:5173/miniapps/missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load by URL' }));

    const errorEl = await screen.findByTestId('remote-load-error');
    expect(errorEl.textContent).toMatch(/manifest fetch failed \(404\)/);
  });
});
