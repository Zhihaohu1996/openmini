import { describe, expect, it } from 'vitest';
import {
  assertValidManifest,
  formatManifestIssues,
  MANIFEST_PERMISSIONS,
  ManifestValidationError,
  MAX_NAME_LENGTH,
  parseManifest,
  SUPPORTED_SCHEMA_VERSION,
  validateManifest,
} from './index';

const VALID_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.example.restaurant',
  name: 'Example Restaurant',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage'],
});

describe('@openmini/manifest public API (via index.ts)', () => {
  it('exposes the expected constants', () => {
    expect(SUPPORTED_SCHEMA_VERSION).toBe(1);
    expect(MANIFEST_PERMISSIONS).toEqual(['storage', 'navigation', 'user', 'network']);
    expect(MAX_NAME_LENGTH).toBe(100);
  });

  it('validates a manifest end-to-end through validateManifest', () => {
    const result = validateManifest(JSON.parse(VALID_MANIFEST_JSON));
    expect(result.valid).toBe(true);
  });

  it('parses and validates a manifest end-to-end through parseManifest', () => {
    const result = parseManifest(VALID_MANIFEST_JSON);
    expect(result.valid).toBe(true);
  });

  it('returns the manifest from assertValidManifest when valid', () => {
    const manifest = assertValidManifest(JSON.parse(VALID_MANIFEST_JSON));
    expect(manifest.id).toBe('com.example.restaurant');
  });

  it('throws ManifestValidationError with formatted issues when invalid', () => {
    expect(() => assertValidManifest({})).toThrow(ManifestValidationError);

    const result = validateManifest({});
    if (!result.valid) {
      expect(formatManifestIssues(result.issues)).toContain('Invalid OpenMini manifest:');
    } else {
      throw new Error('expected an invalid result');
    }
  });
});
