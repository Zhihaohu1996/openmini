import type { MiniAppResourceProvider } from '@openmini/runtime';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { describeStorageScope, MiniAppHost } from './MiniAppHost';

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

/**
 * The operator-facing half of package verification. The runtime decides
 * whether a package loads; this decides what the person looking at the
 * screen is told about it.
 */
describe('MiniAppHost provenance display', () => {
  it('says nothing at all when there is no provenance', () => {
    // A built-in fixture was rendered, not a package that was loaded and
    // checked. Inventing a verification result for it in the UI would be
    // the same lie that synthesizing a default provenance would be in the
    // type.
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);
    expect(screen.queryByTestId('miniapp-provenance')).toBeNull();
  });

  it('names the trusted key for a verified package', () => {
    render(
      <MiniAppHost
        manifestJson={validManifestJson}
        resourceProvider={okProvider}
        provenance={{
          baseUrl: 'https://cdn.example.com/app/',
          identity: { verified: true, id: 'com.openmini.test', keyId: 'KEYID123' },
        }}
      />,
    );
    const el = screen.getByTestId('miniapp-provenance');
    expect(el.textContent).toMatch(/verified/);
    expect(el.textContent).toContain('KEYID123');
    expect(el.dataset.verified).toBe('true');
  });

  it('distinguishes unsigned from untrusted-key', () => {
    // Two different situations: nobody vouched, versus somebody did but not
    // anybody this host recognizes. Only the second names a key an operator
    // could choose to add to a trust store.
    const { unmount } = render(
      <MiniAppHost
        manifestJson={validManifestJson}
        resourceProvider={okProvider}
        provenance={{
          baseUrl: 'https://cdn.example.com/app/',
          identity: { verified: false, reason: 'unsigned' },
        }}
      />,
    );
    expect(screen.getByTestId('miniapp-provenance').textContent).toMatch(/unsigned/);
    unmount();

    render(
      <MiniAppHost
        manifestJson={validManifestJson}
        resourceProvider={okProvider}
        provenance={{
          baseUrl: 'https://cdn.example.com/app/',
          identity: { verified: false, reason: 'untrusted-key' },
        }}
      />,
    );
    const el = screen.getByTestId('miniapp-provenance');
    expect(el.textContent).toMatch(/untrusted key/);
    expect(el.dataset.verified).toBe('false');
  });
});

/**
 * Phase 10 moves where a loaded package's data lives. A move nobody can see
 * is indistinguishable from data loss, so the host states which namespace
 * was used and what the migration did.
 */
describe('MiniAppHost storage scope display', () => {
  it('shows nothing until a scope has actually been resolved', () => {
    // Resolution happens on the first storage call, which needs a running
    // sandbox. Before that there is no tier to report, and guessing one
    // would be the same lie as inventing a verification result.
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);
    expect(screen.queryByTestId('miniapp-storage-scope')).toBeNull();
  });

  it('describes each tier, and says when data was inherited but not attested', () => {
    // Exercised directly against the rendering rule rather than through a
    // sandbox, because jsdom cannot run the srcdoc bootstrap that would
    // produce a real storage call. The browser path is covered in e2e.
    const cases = [
      {
        resolution: {
          key: 'v1:id:com.openmini.test',
          tier: 'verified' as const,
          outcome: {
            kind: 'adopted' as const,
            source: 'v1:origin:https://good.example|com.openmini.test',
            sourceTier: 'origin' as const,
            entriesCopied: 3,
            resumed: false,
            attested: false as const,
          },
        },
        expect: [/verified identity/, /carried 3 entries/, /not attested/],
      },
      {
        resolution: {
          key: 'v1:origin:https://evil.example|com.openmini.test',
          tier: 'origin' as const,
          outcome: { kind: 'not-applicable' as const },
        },
        expect: [/origin-bound \(unverified\)/],
      },
      {
        resolution: {
          key: 'com.openmini.test',
          tier: 'embedded' as const,
          outcome: { kind: 'not-applicable' as const },
        },
        expect: [/built-in fixture/],
      },
      {
        resolution: {
          key: 'v1:id:com.openmini.test',
          tier: 'verified' as const,
          outcome: { kind: 'not-adopted' as const, reason: 'legacy-not-opted-in' as const },
        },
        expect: [/nothing carried forward/, /legacy-not-opted-in/],
      },
    ];

    for (const testCase of cases) {
      const described = describeStorageScope(testCase.resolution);
      for (const pattern of testCase.expect) {
        expect(described).toMatch(pattern);
      }
    }
  });
});
