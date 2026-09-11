import { describe, expect, it } from 'vitest';
import { formatManifestIssues, ManifestValidationError } from './errors';
import type { ManifestIssue } from './types';

describe('formatManifestIssues', () => {
  it('formats a bullet list prefixed with the standard heading', () => {
    const issues: ManifestIssue[] = [
      { path: 'version', code: 'INVALID_VERSION', message: 'must be a valid semantic version' },
      { path: 'entry', code: 'INVALID_ENTRY_PATH', message: 'path traversal is not allowed' },
      {
        path: 'permissions[1]',
        code: 'UNKNOWN_PERMISSION',
        message: 'unknown permission "camera"',
      },
    ];

    expect(formatManifestIssues(issues)).toBe(
      [
        'Invalid OpenMini manifest:',
        '- version: must be a valid semantic version',
        '- entry: path traversal is not allowed',
        '- permissions[1]: unknown permission "camera"',
      ].join('\n'),
    );
  });

  it('omits the path prefix for root-level issues', () => {
    const issues: ManifestIssue[] = [
      { path: '', code: 'MALFORMED_JSON', message: 'invalid JSON: Unexpected token' },
    ];

    expect(formatManifestIssues(issues)).toBe(
      'Invalid OpenMini manifest:\n- invalid JSON: Unexpected token',
    );
  });
});

describe('ManifestValidationError', () => {
  it('carries the issues and uses the formatted message', () => {
    const issues: ManifestIssue[] = [
      { path: 'name', code: 'INVALID_NAME', message: 'must not be empty' },
    ];
    const error = new ManifestValidationError(issues);

    expect(error.issues).toBe(issues);
    expect(error.message).toBe(formatManifestIssues(issues));
    expect(error.name).toBe('ManifestValidationError');
    expect(error).toBeInstanceOf(Error);
  });
});
