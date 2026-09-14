import type { MiniAppResourceProvider } from '@openmini/runtime';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { MiniAppHost } from './MiniAppHost';

afterEach(cleanup);

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled;
}

const validManifestJson = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.test',
  name: 'Test App',
  version: '0.1.0',
  entry: 'index.html',
  permissions: [],
});

const okProvider: MiniAppResourceProvider = {
  readText: async () => '<h1>hi</h1>',
};

/**
 * These tests cover the React wiring only (manifest gating, button
 * enablement, lifecycle status text) — not browser-native sandbox behavior
 * (real iframe isolation, postMessage handshake, CSP enforcement). jsdom
 * does not execute `srcdoc` script content, so reaching `ready`/`running`
 * is exercised by the Playwright specs under e2e/, not here.
 */
describe('MiniAppHost', () => {
  it('shows a manifest-invalid message and no controls for an invalid manifest', () => {
    render(<MiniAppHost manifestJson="{ not valid json" resourceProvider={okProvider} />);
    expect(screen.getByTestId('miniapp-status').textContent).toMatch(/manifest invalid/);
    expect(screen.queryByRole('button', { name: 'Load' })).toBeNull();
  });

  it('starts idle with Load enabled and Destroy disabled', () => {
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);
    expect(screen.getByTestId('miniapp-status').textContent).toBe('status: idle');
    expect(isDisabled(screen.getByRole('button', { name: 'Load' }))).toBe(false);
    expect(isDisabled(screen.getByRole('button', { name: 'Destroy' }))).toBe(true);
  });

  it('moves out of idle and enables Destroy once Load is clicked', async () => {
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));

    await waitFor(() => {
      expect(screen.getByTestId('miniapp-status').textContent).not.toBe('status: idle');
    });
    expect(isDisabled(screen.getByRole('button', { name: 'Load' }))).toBe(true);
    expect(isDisabled(screen.getByRole('button', { name: 'Destroy' }))).toBe(false);
  });

  it('returns to a destroyed, re-loadable state when Destroy is clicked', async () => {
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);

    fireEvent.click(screen.getByRole('button', { name: 'Load' }));
    await waitFor(() => {
      expect(screen.getByTestId('miniapp-status').textContent).not.toBe('status: idle');
    });

    fireEvent.click(screen.getByRole('button', { name: 'Destroy' }));

    expect(screen.getByTestId('miniapp-status').textContent).toBe('status: destroyed');
    expect(isDisabled(screen.getByRole('button', { name: 'Load' }))).toBe(false);
    expect(isDisabled(screen.getByRole('button', { name: 'Destroy' }))).toBe(true);
  });
});
