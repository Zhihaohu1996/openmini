import { TRUST_CONFIG_FILENAME, TRUST_CONFIG_VERSION } from '@openmini/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTrustConfig, readTrustConfigSource, TRUST_CONFIG_SOURCES } from './trustConfig';

/**
 * Phase 11 W6. The host reads a real `openmini.trust.json` at startup.
 *
 * These tests are mostly about the failures, because the failures are where
 * the security property lives: every one of them has to end in a state that
 * refuses the load path, and none of them may end in an empty trust store.
 */

const KEY_A =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu5el220Y9BqnQsr/xLSeWOU0w/pZcdAqU+b+xcSG/pq/HlLuMho6QEur8bUoU2HuLrOLutm9GFq8hdDAYwwwUg==';
const KEY_B = KEY_A.replace('u5el', 'v6fm');

const originalFetch = global.fetch;
afterEach(() => {
  global.fetch = originalFetch;
});

function serve(body: string, status = 200): void {
  global.fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

const configJson = (packages: unknown): string =>
  JSON.stringify({ trustConfigVersion: TRUST_CONFIG_VERSION, packages });

describe('choosing where to read the configuration from', () => {
  it('defaults to openmini.trust.json beside the app', () => {
    expect(readTrustConfigSource('')).toBe(`/${TRUST_CONFIG_FILENAME}`);
  });

  it('honours the allowlisted test sources', () => {
    expect(readTrustConfigSource('?trust=invalid')).toBe(TRUST_CONFIG_SOURCES.invalid);
    expect(readTrustConfigSource('?trust=missing')).toBe(TRUST_CONFIG_SOURCES.missing);
  });

  it('ignores anything not on the allowlist, rather than fetching it', () => {
    // The query string is attacker-reachable in a way `?scenario=` already
    // is, and a host that fetched whatever it named would be a fetch proxy
    // that then *trusts* what comes back.
    expect(readTrustConfigSource('?trust=https://evil.example/trust.json')).toBe(
      `/${TRUST_CONFIG_FILENAME}`,
    );
    expect(readTrustConfigSource('?trust=../../etc/passwd')).toBe(`/${TRUST_CONFIG_FILENAME}`);
  });
});

describe('a configuration the validator accepts', () => {
  it('becomes a trust store keyed by package id', async () => {
    serve(configJson({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } }));

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.registeredIds).toBe(1);
    expect(state.trustStore['com.example.notes']).toEqual([{ publicKey: KEY_A, status: 'active' }]);
  });

  it('carries revoked keys through to the store rather than dropping them', async () => {
    // Dropping them would turn a revoked key back into an unregistered one
    // at the last moment, collapsing the refusal W3 exists to keep separate.
    serve(
      configJson({
        'com.example.notes': {
          keys: [
            { publicKey: KEY_A, status: 'revoked' },
            { publicKey: KEY_B, status: 'active' },
          ],
        },
      }),
    );

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.trustStore['com.example.notes']).toEqual([
      { publicKey: KEY_A, status: 'revoked' },
      { publicKey: KEY_B, status: 'active' },
    ]);
  });

  it('keeps an id registered even when every key is revoked', async () => {
    serve(configJson({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'revoked' }] } }));

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    // Present, not absent. Presence is what makes an unsigned package
    // claiming this id fail closed.
    expect('com.example.notes' in state.trustStore).toBe(true);
  });
});

describe('a configuration the host cannot use', () => {
  it('reports a missing file, and produces no trust store', async () => {
    serve('', 404);

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    expect(state).not.toHaveProperty('trustStore');
  });

  it('reports a fetch that threw', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.reason).toContain('could not fetch');
  });

  it('reports malformed JSON through the shared formatter', async () => {
    serve('{ "trustConfigVersion": 1, ');

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.reason).toContain(`Invalid ${TRUST_CONFIG_FILENAME}`);
    expect(state.reason).toContain('invalid JSON');
  });

  it('refuses an unsupported version rather than reading it anyway', async () => {
    serve(JSON.stringify({ trustConfigVersion: 99, packages: {} }));

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.reason).toContain('unsupported trustConfigVersion');
  });

  it('refuses an unknown field rather than ignoring it', async () => {
    serve(JSON.stringify({ trustConfigVersion: 1, packages: {}, notAfter: '2027-01-01' }));

    const state = await loadTrustConfig('/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.reason).toContain('notAfter');
  });

  it('never degrades a broken configuration into an empty one', async () => {
    // The failure mode this phase names explicitly. An empty store registers
    // no ids, so nothing fails closed, and an impostor of a registered id
    // loads as merely unverified -- fail-open wearing the word "empty". The
    // state must carry no store at all, so a caller cannot reach one.
    for (const body of ['', '{}', 'null', '[]', '{"trustConfigVersion":1}']) {
      serve(body);
      const state = await loadTrustConfig('/openmini.trust.json');
      expect(state.status).toBe('unavailable');
      expect(state).not.toHaveProperty('trustStore');
    }
  });

  it('names the file it could not use', async () => {
    serve('nope');

    const state = await loadTrustConfig('/somewhere/openmini.trust.json');

    expect(state.status).toBe('unavailable');
    if (state.status !== 'unavailable') return;
    expect(state.source).toBe('/somewhere/openmini.trust.json');
    expect(state.reason).toContain('/somewhere/openmini.trust.json');
  });
});
