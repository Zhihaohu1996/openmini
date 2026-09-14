import { describe, expect, it } from 'vitest';
import { gateManifest } from './manifestGate';

const validManifestJson = JSON.stringify({
  schemaVersion: 1,
  id: 'com.openmini.sandbox-demo',
  name: 'OpenMini Sandbox Demo',
  version: '0.1.0',
  entry: 'index.html',
  permissions: [],
});

describe('gateManifest', () => {
  it('proceeds (ok: true) for a valid manifest', () => {
    const result = gateManifest(validManifestJson);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.id).toBe('com.openmini.sandbox-demo');
    }
  });

  it('halts (ok: false) for malformed JSON', () => {
    const result = gateManifest('{ not valid json');
    expect(result.ok).toBe(false);
  });

  it('halts (ok: false) for an unsupported schemaVersion', () => {
    const result = gateManifest(JSON.stringify({ ...JSON.parse(validManifestJson), schemaVersion: 2 }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/schemaVersion/i);
    }
  });

  it('halts (ok: false) for a manifest missing required fields', () => {
    const result = gateManifest(JSON.stringify({ schemaVersion: 1 }));
    expect(result.ok).toBe(false);
  });

  it('reports all issues via formatManifestIssues, not just the first', () => {
    const result = gateManifest(
      JSON.stringify({ ...JSON.parse(validManifestJson), version: 'not-semver', entry: '../x' }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/version/);
      expect(result.reason).toMatch(/entry/);
    }
  });
});
