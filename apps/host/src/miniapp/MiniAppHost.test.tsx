import type { MiniAppResourceProvider, PackageProvenance } from '@openmini/runtime';
import type { UserProfile } from '@openmini/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describeRefusal,
  describeStorageScope,
  describeUserIdentity,
  MiniAppHost,
} from './MiniAppHost';

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

const userManifestJson = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.test',
  name: 'Test App',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['user'],
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

/**
 * Phase 11 W6. A refused load never becomes provenance, so the refusal is
 * the only thing the operator sees — and the three trust-store refusals
 * have three different remedies.
 */
describe('MiniAppHost refusal display', () => {
  it('distinguishes a revoked key from an untrusted one', () => {
    // The distinction this phase exists to make visible. Both are "signed
    // by a key you cannot use", and the remedies are opposites: register
    // the untrusted one if it belongs to the publisher, and do *not*
    // re-register the revoked one, because retiring it was deliberate.
    const revoked = describeRefusal({ code: 'revoked-key', reason: 'refused' });
    const untrusted = describeRefusal({ code: 'untrusted-key', reason: 'refused' });

    expect(revoked).not.toBe(untrusted);
    expect(revoked).toContain('revoked');
    expect(revoked).toContain('Re-signing');
    expect(untrusted).toContain('never registered');
  });

  it('tells an operator not to undo a revocation by re-trusting the key', () => {
    const text = describeRefusal({ code: 'revoked-key', reason: 'refused' });

    expect(text).toContain('undo the revocation');
  });

  it('explains that an unsigned registered id is refused rather than downgraded', () => {
    const text = describeRefusal({ code: 'unsigned-registered', reason: 'refused' });

    expect(text).toContain('refused rather than loaded unverified');
  });

  it('keeps the runtime reason, and adds to it rather than replacing it', () => {
    // The prose the runtime produced names the id and the keyId. Losing it
    // would cost the operator the only concrete detail in the message.
    for (const code of ['revoked-key', 'untrusted-key', 'unsigned-registered'] as const) {
      expect(describeRefusal({ code, reason: 'the runtime said this' })).toContain(
        'the runtime said this',
      );
    }
  });

  it('falls through to the reason for refusals with no remedy to add', () => {
    // Deliberately not an exhaustive switch with a message per code. A
    // tampered package or a bad digest is already fully described by the
    // runtime, and restating it here would be a second wording to keep in
    // step with the first.
    expect(describeRefusal({ code: 'manifest-digest-mismatch', reason: 'bytes moved' })).toBe(
      'bytes moved',
    );
    expect(describeRefusal({ reason: 'manifest fetch failed (404)' })).toBe(
      'manifest fetch failed (404)',
    );
  });

  it('selects on the code, never on the wording of the reason', () => {
    // If this matched on prose, a reason mentioning "revoked" would pick up
    // the revoked remedy even when the code says otherwise -- and improving
    // a sentence would silently change which advice an operator reads.
    const text = describeRefusal({
      code: 'untrusted-key',
      reason: 'this sentence mentions a revoked key but is not one',
    });

    expect(text).toContain('never registered');
    expect(text).not.toContain('undo the revocation');
  });
});

/**
 * Phase 12 W5. The host hands a verified package its demo profile, and
 * reports to the operator what it handed over or withheld.
 *
 * The Mini App sees one indistinguishable anonymous value for every reason
 * it was refused an identity. The operator sees the reason. That asymmetry
 * is deliberate -- distinguishing them is a probe when the package does it
 * and a diagnosis when the operator does -- so it is asserted here rather
 * than left to be inferred.
 */
describe('describeUserIdentity', () => {
  const DEMO: UserProfile = { id: 'demo-user', displayName: 'Demo User (synthetic)' };

  const verified: PackageProvenance = {
    baseUrl: 'https://cdn.example.com/apps/notes/',
    identity: { verified: true, id: 'com.example.notes', keyId: 'KEY-A' },
  };
  const unsigned: PackageProvenance = {
    baseUrl: 'https://cdn.example.com/apps/notes/',
    identity: { verified: false, reason: 'unsigned' },
  };
  const untrusted: PackageProvenance = {
    baseUrl: 'https://cdn.example.com/apps/notes/',
    identity: { verified: false, reason: 'untrusted-key' },
  };

  it('reports the profile as shared when both gates pass', () => {
    const result = describeUserIdentity({
      provenance: verified,
      permissions: ['user'],
      userProfile: DEMO,
    });

    expect(result.disclosure).toBe('shared');
    expect(result.text).toContain('demo-user');
  });

  it('reports a package that never asked, separately from one that was refused', () => {
    // The two most confusable states for an operator: nothing happened
    // because the app did not ask, versus nothing happened because the host
    // declined. They have different fixes.
    const notRequested = describeUserIdentity({
      provenance: verified,
      permissions: ['storage'],
      userProfile: DEMO,
    });
    const withheld = describeUserIdentity({
      provenance: unsigned,
      permissions: ['user'],
      userProfile: DEMO,
    });

    expect(notRequested.disclosure).toBe('not-requested');
    expect(withheld.disclosure).toBe('withheld');
    expect(notRequested.text).not.toBe(withheld.text);
  });

  it('reports withheld for every unverified reason', () => {
    for (const provenance of [unsigned, untrusted]) {
      expect(
        describeUserIdentity({ provenance, permissions: ['user'], userProfile: DEMO }).disclosure,
      ).toBe('withheld');
    }
  });

  it('distinguishes "nobody configured" from "withheld"', () => {
    // Both end in the Mini App receiving an anonymous profile, and an
    // operator debugging that needs to know which one happened.
    const result = describeUserIdentity({ provenance: verified, permissions: ['user'] });

    expect(result.disclosure).toBe('none-configured');
    expect(result.text).toContain('no demo profile');
  });

  it('checks the permission before the provenance, as the handler path does', () => {
    // An unverified package that also never asked is reported as not having
    // asked, because that is the first gate it failed and the first thing
    // to fix. The order here mirrors the dispatcher, which refuses on
    // permission before any handler runs.
    const result = describeUserIdentity({
      provenance: unsigned,
      permissions: [],
      userProfile: DEMO,
    });

    expect(result.disclosure).toBe('not-requested');
  });

  it('never claims the host authenticated anyone', () => {
    // Wording guard. This host signs nobody in, and the phrase an operator
    // reads must not suggest otherwise.
    const texts = [
      describeUserIdentity({ provenance: verified, permissions: ['user'], userProfile: DEMO }).text,
      describeUserIdentity({ provenance: unsigned, permissions: ['user'], userProfile: DEMO }).text,
      describeUserIdentity({ provenance: verified, permissions: ['user'] }).text,
      describeUserIdentity({ provenance: verified, permissions: [], userProfile: DEMO }).text,
    ];

    for (const text of texts) {
      expect(text).not.toMatch(/logged in|signed in|authenticat|login|account holder/i);
    }
  });
});

describe('MiniAppHost user identity display', () => {
  const verified: PackageProvenance = {
    baseUrl: 'https://cdn.example.com/apps/notes/',
    identity: { verified: true, id: 'com.openmini.test', keyId: 'KEY-A' },
  };

  it('shows nothing at all when no package was loaded', () => {
    // Same rule the provenance line follows: a fixture was never subject to
    // a check, so the host makes no claim about it either way.
    render(<MiniAppHost manifestJson={validManifestJson} resourceProvider={okProvider} />);

    expect(screen.queryByTestId('miniapp-user-identity')).toBeNull();
  });

  it('reports the disclosure for a loaded package', () => {
    render(
      <MiniAppHost
        manifestJson={userManifestJson}
        resourceProvider={okProvider}
        provenance={verified}
        userProfile={{ id: 'demo-user', displayName: 'Demo User (synthetic)' }}
      />,
    );

    const line = screen.getByTestId('miniapp-user-identity');
    expect(line.getAttribute('data-disclosure')).toBe('shared');
    expect(line.textContent).toContain('demo-user');
  });

  it('reports withholding from an unverified package', () => {
    render(
      <MiniAppHost
        manifestJson={userManifestJson}
        resourceProvider={okProvider}
        provenance={{
          baseUrl: verified.baseUrl,
          identity: { verified: false, reason: 'unsigned' },
        }}
        userProfile={{ id: 'demo-user', displayName: 'Demo User (synthetic)' }}
      />,
    );

    expect(screen.getByTestId('miniapp-user-identity').getAttribute('data-disclosure')).toBe(
      'withheld',
    );
  });
});
