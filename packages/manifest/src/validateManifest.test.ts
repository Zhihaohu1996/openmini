import { describe, expect, it } from 'vitest';
import { validateManifest } from './validateManifest';

const VALID_MANIFEST = {
  schemaVersion: 1,
  id: 'com.example.restaurant',
  name: 'Example Restaurant',
  version: '0.1.0',
  entry: 'index.html',
  permissions: ['storage'],
};

describe('validateManifest — valid manifests', () => {
  it('accepts a minimal valid manifest', () => {
    const result = validateManifest(VALID_MANIFEST);
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.manifest).toEqual(VALID_MANIFEST);
    }
  });

  it('accepts all three supported permissions', () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      permissions: ['storage', 'navigation', 'user'],
    });
    expect(result.valid).toBe(true);
  });

  it('accepts an empty permissions array', () => {
    const result = validateManifest({ ...VALID_MANIFEST, permissions: [] });
    expect(result.valid).toBe(true);
  });
});

describe('validateManifest — invalid root', () => {
  it.each([null, 42, 'string', ['array']])('rejects a non-object root %j', (value) => {
    const result = validateManifest(value);
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: '', code: 'INVALID_ROOT_TYPE' }),
      ]);
    }
  });
});

describe('validateManifest — missing required fields', () => {
  it.each(['schemaVersion', 'id', 'name', 'version', 'entry', 'permissions'] as const)(
    'reports %s as missing when absent',
    (field) => {
      const manifest = { ...VALID_MANIFEST };
      delete (manifest as Record<string, unknown>)[field];

      const result = validateManifest(manifest);
      expect(result.valid).toBe(false);
      if (!result.valid) {
        expect(result.issues).toContainEqual(
          expect.objectContaining({ path: field, code: 'MISSING_FIELD' }),
        );
      }
    },
  );
});

describe('validateManifest — unsupported schemaVersion', () => {
  it.each([0, 2, '1', 1.5])('rejects schemaVersion %j', (value) => {
    const result = validateManifest({ ...VALID_MANIFEST, schemaVersion: value });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'schemaVersion' }),
      ]);
    }
  });
});

describe('validateManifest — invalid field values', () => {
  it('rejects an invalid app id', () => {
    const result = validateManifest({ ...VALID_MANIFEST, id: 'com' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([expect.objectContaining({ path: 'id', code: 'INVALID_ID' })]);
    }
  });

  it('rejects an empty name', () => {
    const result = validateManifest({ ...VALID_MANIFEST, name: '' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'name', code: 'INVALID_NAME' }),
      ]);
    }
  });

  it('rejects a name over the maximum length', () => {
    const result = validateManifest({ ...VALID_MANIFEST, name: 'a'.repeat(101) });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'name', code: 'INVALID_NAME' }),
      ]);
    }
  });

  it('rejects an invalid semantic version', () => {
    const result = validateManifest({ ...VALID_MANIFEST, version: '1.0' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'version', code: 'INVALID_VERSION' }),
      ]);
    }
  });

  it('rejects an absolute filesystem path entry', () => {
    const result = validateManifest({ ...VALID_MANIFEST, entry: '/etc/x' });
    expect(result.valid).toBe(false);
  });

  it('rejects a root-absolute entry', () => {
    const result = validateManifest({ ...VALID_MANIFEST, entry: '/index.html' });
    expect(result.valid).toBe(false);
  });

  it('rejects a URL entry', () => {
    const result = validateManifest({ ...VALID_MANIFEST, entry: 'https://example.com' });
    expect(result.valid).toBe(false);
  });

  it('rejects a path-traversal entry', () => {
    const result = validateManifest({ ...VALID_MANIFEST, entry: '../index.html' });
    expect(result.valid).toBe(false);
  });

  it('rejects an unknown permission', () => {
    const result = validateManifest({ ...VALID_MANIFEST, permissions: ['camera'] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'permissions[0]', code: 'UNKNOWN_PERMISSION' }),
      ]);
    }
  });

  it('rejects a duplicate permission', () => {
    const result = validateManifest({ ...VALID_MANIFEST, permissions: ['storage', 'storage'] });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'permissions[1]', code: 'DUPLICATE_PERMISSION' }),
      ]);
    }
  });
});

describe('validateManifest — wrong field types', () => {
  it.each([
    ['schemaVersion', '1'],
    ['id', 42],
    ['name', 42],
    ['version', 42],
    ['entry', 42],
    ['permissions', { storage: true }],
  ] as const)('rejects %s with the wrong type', (field, value) => {
    const result = validateManifest({ ...VALID_MANIFEST, [field]: value });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([expect.objectContaining({ path: field })]);
    }
  });
});

describe('validateManifest — unknown top-level fields', () => {
  it('rejects an unrecognized field', () => {
    const result = validateManifest({ ...VALID_MANIFEST, extraField: 'nope' });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'extraField', code: 'UNKNOWN_FIELD' }),
      ]);
    }
  });
});

describe('validateManifest — aggregated issues', () => {
  it('reports multiple unrelated errors together, not just the first', () => {
    const result = validateManifest({
      ...VALID_MANIFEST,
      version: 'not-a-version',
      entry: '../index.html',
      permissions: ['storage', 'camera'],
    });

    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.issues).toEqual([
        expect.objectContaining({ path: 'version', code: 'INVALID_VERSION' }),
        expect.objectContaining({ path: 'entry', code: 'INVALID_ENTRY_PATH' }),
        expect.objectContaining({ path: 'permissions[1]', code: 'UNKNOWN_PERMISSION' }),
      ]);
    }
  });
});
