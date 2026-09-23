import { describe, expect, it } from 'vitest';
import {
  formatTrustConfigIssues,
  parseTrustConfig,
  TRUST_CONFIG_FILENAME,
  TRUST_CONFIG_VERSION,
  validateTrustConfig,
} from './trustConfig';
import type { TrustConfigIssue, TrustConfigIssueCode } from './trustConfig';

/**
 * Phase 11 W1. The format is validated here and wired to nothing — no load
 * path consults it until W2/W3. See docs/plans/phase-11.md.
 */

/** A real, well-formed base64 P-256 SPKI key, borrowed from the Phase 9 docs. */
const KEY_A =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu5el220Y9BqnQsr/xLSeWOU0w/pZcdAqU+b+xcSG/pq/HlLuMho6QEur8bUoU2HuLrOLutm9GFq8hdDAYwwwUg==';
/**
 * A second, different key. Derived from the first by substituting base64
 * characters rather than written out by hand, so it is guaranteed to stay
 * well-formed — these tests are about the format, and a hand-typed blob with
 * accidentally wrong padding would fail for a reason none of them mean.
 */
const KEY_B = KEY_A.replace('u5el', 'v6fm');

function config(packages: unknown): unknown {
  return { trustConfigVersion: TRUST_CONFIG_VERSION, packages };
}

function codes(issues: readonly TrustConfigIssue[]): TrustConfigIssueCode[] {
  return issues.map((issue) => issue.code);
}

function expectInvalid(input: unknown): TrustConfigIssue[] {
  const result = validateTrustConfig(input);
  if (result.valid) {
    throw new Error('expected the config to be rejected, but it validated');
  }
  return result.issues;
}

describe('a well-formed trust configuration', () => {
  it('accepts an active key', () => {
    const result = validateTrustConfig(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } }),
    );

    expect(result).toEqual({
      valid: true,
      config: {
        trustConfigVersion: 1,
        packages: { 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } },
      },
    });
  });

  it('accepts an active key alongside a revoked one, which is what rotation looks like', () => {
    const result = validateTrustConfig(
      config({
        'com.example.notes': {
          keys: [
            { publicKey: KEY_B, status: 'active' },
            { publicKey: KEY_A, status: 'revoked' },
          ],
        },
      }),
    );

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.packages['com.example.notes']?.keys).toEqual([
      { publicKey: KEY_B, status: 'active' },
      { publicKey: KEY_A, status: 'revoked' },
    ]);
  });

  it('keeps an optional keyId label, which exists to be read by humans and by nothing else', () => {
    const result = validateTrustConfig(
      config({
        'com.example.notes': {
          keys: [{ publicKey: KEY_A, status: 'active', keyId: 'laptop-2026' }],
        },
      }),
    );

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.packages['com.example.notes']?.keys[0]).toEqual({
      publicKey: KEY_A,
      status: 'active',
      keyId: 'laptop-2026',
    });
  });

  it('accepts a config that registers nothing', () => {
    // An operator who has registered no ids. Distinct from a *broken* config:
    // this one says something, and what it says is "I claim to know who owns
    // nothing". How a host treats each is W6's problem, not the format's.
    const result = validateTrustConfig(config({}));

    expect(result.valid).toBe(true);
  });

  it('accepts an id with no keys at all, which still registers the id', () => {
    // The degenerate case of every key being revoked: the host is still
    // asserting it knows who owns this id, so a package claiming it must
    // still fail closed. Registration is presence of the id.
    const result = validateTrustConfig(config({ 'com.example.notes': { keys: [] } }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.packages['com.example.notes']).toEqual({ keys: [] });
  });
});

describe('status is explicit, and there are exactly two of them', () => {
  it('refuses a key with no status rather than assuming it is active', () => {
    // The whole point of the phase. Defaulting an omitted status to "active"
    // would mean a key grants trust because a field was forgotten.
    const issues = expectInvalid(config({ 'com.example.notes': { keys: [{ publicKey: KEY_A }] } }));

    expect(codes(issues)).toContain('MISSING_FIELD');
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys[0].status');
    expect(issues[0]?.message).toMatch(/never inferred/);
  });

  it('refuses an unknown status, including expiry-flavoured ones', () => {
    // `expired` is not a state this format has, deliberately: an expiry would
    // put the host's clock into the load decision. Phase 11 defers it rather
    // than approximating it, and this test is what keeps it deferred.
    const issues = expectInvalid(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'expired' }] } }),
    );

    expect(codes(issues)).toEqual(['INVALID_KEY_STATUS']);
    expect(issues[0]?.message).toMatch(/active, revoked/);
  });

  it('refuses a non-string status', () => {
    const issues = expectInvalid(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: true }] } }),
    );

    expect(codes(issues)).toEqual(['INVALID_KEY_STATUS']);
  });
});

describe('unknown fields are rejected everywhere', () => {
  it('rejects an unknown root field', () => {
    const issues = expectInvalid({
      trustConfigVersion: TRUST_CONFIG_VERSION,
      packages: {},
      registry: 'https://keys.example/',
    });

    expect(codes(issues)).toEqual(['UNKNOWN_FIELD']);
    expect(issues[0]?.path).toBe('registry');
  });

  it('rejects an unknown field on a package entry', () => {
    const issues = expectInvalid(config({ 'com.example.notes': { keys: [], default: true } }));

    expect(codes(issues)).toEqual(['UNKNOWN_FIELD']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].default');
  });

  it('rejects an unknown field on a key entry, notAfter included', () => {
    // If a later phase adds validity windows it does so with a version bump,
    // not by a field this reader happens to ignore.
    const issues = expectInvalid(
      config({
        'com.example.notes': {
          keys: [{ publicKey: KEY_A, status: 'active', notAfter: '2027-01-01T00:00:00Z' }],
        },
      }),
    );

    expect(codes(issues)).toEqual(['UNKNOWN_FIELD']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys[0].notAfter');
  });
});

describe('the version is refused, not best-effort parsed', () => {
  it.each([0, 2, '1', null, 1.5])('rejects trustConfigVersion %p', (version) => {
    const issues = expectInvalid({ trustConfigVersion: version, packages: {} });

    expect(codes(issues)).toEqual(['UNSUPPORTED_TRUST_CONFIG_VERSION']);
  });

  it('rejects a missing version', () => {
    const issues = expectInvalid({ packages: {} });

    expect(codes(issues)).toEqual(['MISSING_FIELD']);
    expect(issues[0]?.path).toBe('trustConfigVersion');
  });
});

describe('structural failures', () => {
  it.each([null, 42, 'a string', [], true])('rejects a root that is %p', (root) => {
    const issues = expectInvalid(root);

    expect(codes(issues)).toEqual(['INVALID_ROOT_TYPE']);
  });

  it('rejects a missing packages map', () => {
    const issues = expectInvalid({ trustConfigVersion: TRUST_CONFIG_VERSION });

    expect(codes(issues)).toEqual(['MISSING_FIELD']);
    expect(issues[0]?.path).toBe('packages');
  });

  it.each([[[]], ['x'], [null], [7]])('rejects a packages map that is %p', (packages) => {
    const issues = expectInvalid(config(packages));

    expect(codes(issues)).toEqual(['INVALID_TYPE']);
    expect(issues[0]?.path).toBe('packages');
  });

  it('rejects a package entry that is not an object', () => {
    const issues = expectInvalid(config({ 'com.example.notes': [KEY_A] }));

    expect(codes(issues)).toEqual(['INVALID_TYPE']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"]');
  });

  it('rejects a package entry with no keys array', () => {
    const issues = expectInvalid(config({ 'com.example.notes': {} }));

    expect(codes(issues)).toEqual(['MISSING_FIELD']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys');
  });

  it('rejects keys that is not an array', () => {
    const issues = expectInvalid(config({ 'com.example.notes': { keys: { publicKey: KEY_A } } }));

    expect(codes(issues)).toEqual(['INVALID_TYPE']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys');
  });

  it('rejects a bare string where a key entry belongs', () => {
    // The legacy runtime trust store is an array of bare strings. This file
    // format has exactly one spelling, and normalizing the legacy shape is
    // the runtime's job (W2), not a second syntax here.
    const issues = expectInvalid(config({ 'com.example.notes': { keys: [KEY_A] } }));

    expect(codes(issues)).toEqual(['INVALID_TYPE']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys[0]');
  });

  it('rejects an empty package id', () => {
    const issues = expectInvalid(config({ '': { keys: [] } }));

    expect(codes(issues)).toEqual(['INVALID_PACKAGE_ID']);
  });
});

describe('publicKey', () => {
  it('rejects a missing publicKey', () => {
    const issues = expectInvalid(config({ 'com.example.notes': { keys: [{ status: 'active' }] } }));

    expect(codes(issues)).toEqual(['MISSING_FIELD']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys[0].publicKey');
  });

  it('rejects a non-string publicKey', () => {
    const issues = expectInvalid(
      config({ 'com.example.notes': { keys: [{ publicKey: 123, status: 'active' }] } }),
    );

    expect(codes(issues)).toEqual(['INVALID_TYPE']);
  });

  it.each(['', 'not base64!', 'MFkwEwYHKoZIzj0CAQ'])('rejects publicKey %p', (publicKey) => {
    const issues = expectInvalid(
      config({ 'com.example.notes': { keys: [{ publicKey, status: 'active' }] } }),
    );

    expect(codes(issues)).toEqual(['INVALID_PUBLIC_KEY']);
  });

  it('rejects the same key listed twice for one id', () => {
    // One key cannot be both active and revoked, and a reader that picked
    // either would be picking for the operator.
    const issues = expectInvalid(
      config({
        'com.example.notes': {
          keys: [
            { publicKey: KEY_A, status: 'active' },
            { publicKey: KEY_A, status: 'revoked' },
          ],
        },
      }),
    );

    expect(codes(issues)).toEqual(['DUPLICATE_PUBLIC_KEY']);
    expect(issues[0]?.path).toBe('packages["com.example.notes"].keys[1].publicKey');
  });

  it('allows the same key to be registered for two different ids', () => {
    // Key status is per id, so one signing key serving two apps is ordinary.
    const result = validateTrustConfig(
      config({
        'com.example.a': { keys: [{ publicKey: KEY_A, status: 'active' }] },
        'com.example.b': { keys: [{ publicKey: KEY_A, status: 'revoked' }] },
      }),
    );

    expect(result.valid).toBe(true);
  });
});

describe('keyId is a label and is treated as one', () => {
  it.each([{ keyId: '' }, { keyId: 42 }, { keyId: null }])(
    'rejects keyId $keyId, because a label nobody can read is worse than none',
    ({ keyId }) => {
      const issues = expectInvalid(
        config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active', keyId }] } }),
      );

      expect(codes(issues)).toEqual(['INVALID_KEY_ID']);
    },
  );

  it('does not check the label against the key it labels', () => {
    // Deliberate. Verifying it needs a digest, which would make this
    // validator asynchronous for the sake of a comment field. What protects
    // the trust decision is not that the label is right — it is that the
    // decision never reads it. The runtime side of that is pinned in W2/W3.
    const result = validateTrustConfig(
      config({
        'com.example.notes': {
          keys: [{ publicKey: KEY_A, status: 'active', keyId: 'this-label-is-simply-wrong' }],
        },
      }),
    );

    expect(result.valid).toBe(true);
  });
});

describe('nothing is registered unless everything validates', () => {
  it('collects every issue rather than stopping at the first', () => {
    const issues = expectInvalid({
      trustConfigVersion: 9,
      packages: {
        'com.example.a': { keys: [{ publicKey: 'nope!', status: 'active' }] },
        'com.example.b': { keys: [{ publicKey: KEY_A }] },
      },
    });

    expect(codes(issues)).toEqual([
      'UNSUPPORTED_TRUST_CONFIG_VERSION',
      'INVALID_PUBLIC_KEY',
      'MISSING_FIELD',
    ]);
  });

  it('registers nothing at all when one entry is bad', () => {
    // No partial config: "most of your trust configuration applied" is not a
    // state an operator should have to reason about.
    const result = validateTrustConfig(
      config({
        'com.example.good': { keys: [{ publicKey: KEY_A, status: 'active' }] },
        'com.example.bad': { keys: [{ publicKey: KEY_B, status: 'sometimes' }] },
      }),
    );

    expect(result.valid).toBe(false);
  });
});

describe('the packages map cannot reach Object.prototype', () => {
  it('treats __proto__ as an ordinary package id', () => {
    const result = validateTrustConfig(
      parseJson(`{
        "trustConfigVersion": 1,
        "packages": { "__proto__": { "keys": [{ "publicKey": "${KEY_A}", "status": "active" }] } }
      }`),
    );

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(Object.keys(result.config.packages)).toEqual(['__proto__']);
    expect(({} as Record<string, unknown>).keys).toBeUndefined();
  });

  it('does not report a key registered for an id nobody configured', () => {
    // A plain-object map would answer `packages['constructor']` with an
    // inherited member. A null-prototype map answers with undefined, which is
    // the only answer that fails closed.
    const result = validateTrustConfig(config({ 'com.example.notes': { keys: [] } }));

    expect(result.valid).toBe(true);
    if (!result.valid) return;
    expect(result.config.packages['constructor']).toBeUndefined();
    expect(result.config.packages['toString']).toBeUndefined();
  });
});

describe('parseTrustConfig', () => {
  it('parses valid text', () => {
    const result = parseTrustConfig(
      JSON.stringify(
        config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } }),
      ),
    );

    expect(result.valid).toBe(true);
  });

  it('reports malformed JSON as its own issue', () => {
    const result = parseTrustConfig('{ not json');

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(codes(result.issues)).toEqual(['MALFORMED_JSON']);
  });
});

describe('formatTrustConfigIssues', () => {
  it('names the file and lists each issue with its path', () => {
    const issues = expectInvalid(config({ 'com.example.notes': { keys: [{ publicKey: KEY_A }] } }));

    expect(formatTrustConfigIssues(issues)).toBe(
      `Invalid ${TRUST_CONFIG_FILENAME}:\n` +
        '- packages["com.example.notes"].keys[0].status: is required and is never inferred; ' +
        'write one of: active, revoked',
    );
  });

  it('omits the separator for an issue with no path', () => {
    expect(
      formatTrustConfigIssues([{ path: '', code: 'MALFORMED_JSON', message: 'invalid JSON: x' }]),
    ).toBe(`Invalid ${TRUST_CONFIG_FILENAME}:\n- invalid JSON: x`);
  });
});

function parseJson(raw: string): unknown {
  return JSON.parse(raw);
}
