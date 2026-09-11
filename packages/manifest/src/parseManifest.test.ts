import { describe, expect, it } from 'vitest';
import { assertValidManifest, parseManifest } from './parseManifest';
import { ManifestValidationError } from './errors';

const VALID_MANIFEST_JSON = JSON.stringify({
  schemaVersion: 1,
  id: 'com.example.restaurant',
  name: 'Example Restaurant',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage'],
});

describe('parseManifest', () => {
  it('parses and validates a well-formed, valid manifest', () => {
    const result = parseManifest(VALID_MANIFEST_JSON);
    expect(result.valid).toBe(true);
  });

  it.each(['{', '{"id": }', 'not json at all', ''])(
    'reports malformed JSON without touching validation for %s',
    (raw) => {
      const result = parseManifest(raw);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues).toEqual([
          expect.objectContaining({ path: '', code: 'MALFORMED_JSON' }),
        ]);
      }
    },
  );

  it('validates parsed JSON that is well-formed but semantically invalid', () => {
    const result = parseManifest(JSON.stringify({ schemaVersion: 2 }));
    expect(result.valid).toBe(false);
  });
});

describe('assertValidManifest', () => {
  it('returns the manifest when valid', () => {
    const manifest = assertValidManifest(JSON.parse(VALID_MANIFEST_JSON));
    expect(manifest.id).toBe('com.example.restaurant');
  });

  it('throws ManifestValidationError when invalid', () => {
    expect(() => assertValidManifest({})).toThrow(ManifestValidationError);
  });
});
