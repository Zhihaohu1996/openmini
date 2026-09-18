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

  it('renders MiniAppHost with the fetched manifest on success', async () => {
    const manifestJson = JSON.stringify({
      schemaVersion: 1,
      id: 'com.openmini.hello-remote',
      name: 'Hello Remote',
      version: '0.1.0',
      entry: 'index.html',
      permissions: [],
    });
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(manifestJson),
    }) as unknown as typeof fetch;

    render(<App />);
    fireEvent.change(screen.getByLabelText('Mini App package URL'), {
      target: { value: 'http://localhost:5173/miniapps/hello-remote' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load by URL' }));

    expect((await screen.findAllByTestId('miniapp-status')).length).toBeGreaterThan(0);
    expect(screen.queryByTestId('remote-load-error')).toBeNull();
  });

  it('shows the fetch-failure reason and does not render MiniAppHost on failure', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      text: () => Promise.resolve(''),
    }) as unknown as typeof fetch;

    render(<App />);
    fireEvent.change(screen.getByLabelText('Mini App package URL'), {
      target: { value: 'http://localhost:5173/miniapps/missing' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Load by URL' }));

    const errorEl = await screen.findByTestId('remote-load-error');
    expect(errorEl.textContent).toMatch(/manifest fetch failed \(404\)/);
  });
});
