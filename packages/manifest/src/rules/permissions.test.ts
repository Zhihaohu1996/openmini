import { describe, expect, it } from 'vitest';
import { checkPermissions } from './permissions';

describe('checkPermissions', () => {
  it('accepts an empty array', () => {
    expect(checkPermissions([], 'permissions')).toEqual([]);
  });

  it('accepts all supported permissions', () => {
    expect(checkPermissions(['storage', 'navigation', 'user', 'network'], 'permissions')).toEqual([]);
  });

  it('rejects a non-array value', () => {
    expect(checkPermissions('storage', 'permissions')).toEqual([
      { path: 'permissions', code: 'INVALID_TYPE', message: 'must be an array' },
    ]);
  });

  it('rejects an unknown permission with its index', () => {
    const issues = checkPermissions(['storage', 'camera'], 'permissions');
    expect(issues).toEqual([
      {
        path: 'permissions[1]',
        code: 'UNKNOWN_PERMISSION',
        message: 'unknown permission "camera"',
      },
    ]);
  });

  it('rejects a duplicate permission at the repeat index', () => {
    const issues = checkPermissions(['storage', 'storage'], 'permissions');
    expect(issues).toEqual([
      {
        path: 'permissions[1]',
        code: 'DUPLICATE_PERMISSION',
        message: 'duplicate permission "storage"',
      },
    ]);
  });

  it('rejects a non-string element', () => {
    const issues = checkPermissions(['storage', 42], 'permissions');
    expect(issues).toEqual([
      { path: 'permissions[1]', code: 'INVALID_TYPE', message: 'must be a string' },
    ]);
  });
});
