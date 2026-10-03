import {
  formatTrustConfigIssues,
  parseTrustConfig,
  TRUST_CONFIG_FILENAME,
  TRUST_CONFIG_VERSION,
} from '@openmini/shared';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateTrustConfigFile } from './trust.js';

/**
 * Phase 11 W5. The command adds no validation of its own, so these tests are
 * about the three things it does own: where it looks for the file, what it
 * exits with, and whether its text is the shared formatter's text rather
 * than a second wording that could drift from it.
 */

/** A real, well-formed base64 P-256 SPKI key, as used by the W1 tests. */
const KEY_A =
  'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEu5el220Y9BqnQsr/xLSeWOU0w/pZcdAqU+b+xcSG/pq/HlLuMho6QEur8bUoU2HuLrOLutm9GFq8hdDAYwwwUg==';
const KEY_B = KEY_A.replace('u5el', 'v6fm');

async function writeConfig(contents: unknown, name = TRUST_CONFIG_FILENAME): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'openmini-trust-'));
  const body = typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2);
  await writeFile(join(dir, name), body, 'utf8');
  return dir;
}

const config = (packages: unknown): unknown => ({
  trustConfigVersion: TRUST_CONFIG_VERSION,
  packages,
});

describe('finding the file', () => {
  it('reads openmini.trust.json from a directory', async () => {
    const dir = await writeConfig(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } }),
    );

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(true);
    expect(result.report).toContain(join(dir, TRUST_CONFIG_FILENAME));
  });

  it('accepts a path to the file itself, under any name', async () => {
    // The same `.json` convention `openmini validate` uses. An operator
    // keeping two configs side by side should not have to rename one to
    // check it.
    const dir = await writeConfig(config({}), 'staging.trust.json');
    const path = join(dir, 'staging.trust.json');

    const result = await validateTrustConfigFile(path);

    expect(result.ok).toBe(true);
    expect(result.report).toContain(path);
  });

  it('reports a missing file as unreadable rather than as invalid', async () => {
    // Different situations, different remedies: write one, versus fix the
    // one you have. The host makes the same distinction in W6.
    const dir = await mkdtemp(join(tmpdir(), 'openmini-trust-'));

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('cannot read trust configuration');
    expect(result.report).not.toContain('Invalid');
  });
});

describe('reporting a valid configuration', () => {
  it('counts the packages and the keys', async () => {
    const dir = await writeConfig(
      config({
        'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] },
        'com.example.other': {
          keys: [
            { publicKey: KEY_A, status: 'active' },
            { publicKey: KEY_B, status: 'revoked' },
          ],
        },
      }),
    );

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(true);
    expect(result.report).toContain('valid (2 packages, 3 keys)');
    expect(result.report).toContain('com.example.notes: 1 active key');
    expect(result.report).toContain('com.example.other: 1 active key, 1 revoked');
  });

  it('lists ids in a stable order, not the order they were typed in', async () => {
    const dir = await writeConfig(
      config({
        'com.example.zebra': { keys: [] },
        'com.example.apple': { keys: [] },
      }),
    );

    const result = await validateTrustConfigFile(dir);
    const lines = result.report.split('\n');

    expect(lines.findIndex((line) => line.includes('com.example.apple'))).toBeLessThan(
      lines.findIndex((line) => line.includes('com.example.zebra')),
    );
  });

  it('spells out an id that nothing may currently sign', async () => {
    // The case an operator most needs explained, and the one "0 active keys"
    // would under-report. Revoking every key does not un-register the id --
    // registration is the presence of the id -- so a package claiming it
    // fails closed rather than loading unverified. Better to read that here
    // than to discover it from a host's refusal.
    const dir = await writeConfig(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'revoked' }] } }),
    );

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(true);
    expect(result.report).toContain('registered, but nothing may currently sign it (1 revoked)');
  });

  it('accepts an id registered with no keys at all', async () => {
    const dir = await writeConfig(config({ 'com.example.notes': { keys: [] } }));

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(true);
    expect(result.report).toContain('valid (1 package, 0 keys)');
  });

  it('accepts a configuration that registers nothing', async () => {
    const dir = await writeConfig(config({}));

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(true);
    expect(result.report).toContain('valid (0 packages, 0 keys)');
  });

  it('says it has not checked whether the keys are the right ones', async () => {
    // The mirror of `openmini verify`'s note. A config listing an attacker's
    // key validates exactly as a correct one does, and the command must not
    // let "valid" be read as "correct".
    const dir = await writeConfig(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'active' }] } }),
    );

    const result = await validateTrustConfigFile(dir);

    expect(result.report).toContain('NOT whether the keys in it are the');
  });
});

describe('reporting an invalid configuration', () => {
  it('prints exactly the shared formatter output, not a second wording', async () => {
    // The reason this command exists in @openmini/cli rather than growing
    // its own checks: an operator comparing a CLI run against what a host
    // reported must not have to work out whether two wordings mean the same
    // thing. Asserted by rendering the same input through the shared
    // formatter directly and requiring the command's report to contain it.
    const raw = JSON.stringify(
      config({ 'com.example.notes': { keys: [{ publicKey: KEY_A, status: 'expired' }] } }),
    );
    const dir = await writeConfig(raw);

    const result = await validateTrustConfigFile(dir);
    const parsed = parseTrustConfig(raw);

    expect(result.ok).toBe(false);
    expect(parsed.valid).toBe(false);
    if (parsed.valid) return;
    expect(result.report).toContain(formatTrustConfigIssues(parsed.issues));
  });

  it('names the file it rejected', async () => {
    const dir = await writeConfig(config({ 'com.example.notes': { keys: [{}] } }));

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain(join(dir, TRUST_CONFIG_FILENAME));
  });

  it('rejects malformed JSON', async () => {
    const dir = await writeConfig('{ "trustConfigVersion": 1, ');

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('invalid JSON');
  });

  it('rejects an unsupported version rather than reading it anyway', async () => {
    const dir = await writeConfig({ trustConfigVersion: 2, packages: {} });

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('unsupported trustConfigVersion');
  });

  it('rejects an unknown field', async () => {
    const dir = await writeConfig({ ...(config({}) as object), notAfter: '2027-01-01' });

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('notAfter');
  });

  it('reports every issue at once, because the file is hand-edited', async () => {
    const dir = await writeConfig({
      packages: {
        'com.example.notes': { keys: [{ publicKey: KEY_A }] },
      },
    });

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).toContain('trustConfigVersion');
    expect(result.report).toContain('status');
  });

  it('registers nothing when any part of the file is invalid', async () => {
    // No partial trust configuration. The valid entry alongside the broken
    // one is not reported as registered, because it is not.
    const dir = await writeConfig(
      config({
        'com.example.good': { keys: [{ publicKey: KEY_A, status: 'active' }] },
        'com.example.bad': { keys: [{ publicKey: KEY_B, status: 'perhaps' }] },
      }),
    );

    const result = await validateTrustConfigFile(dir);

    expect(result.ok).toBe(false);
    expect(result.report).not.toContain('valid (');
    expect(result.report).not.toContain('1 active key');
  });
});
