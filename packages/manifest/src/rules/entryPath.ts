import { ENTRY_PATH_PATTERNS } from '../constants';
import type { ManifestIssue } from '../types';

export function checkEntryPath(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'string') {
    return { path, code: 'INVALID_TYPE', message: 'must be a string' };
  }

  if (value.trim() === '') {
    return { path, code: 'INVALID_ENTRY_PATH', message: 'must not be empty' };
  }

  const segments = value.split(/[\\/]+/);
  if (segments.includes('..')) {
    return {
      path,
      code: 'INVALID_ENTRY_PATH',
      message: 'path traversal is not allowed',
    };
  }

  if (ENTRY_PATH_PATTERNS.urlScheme.test(value)) {
    return { path, code: 'INVALID_ENTRY_PATH', message: 'must not be a URL' };
  }

  if (ENTRY_PATH_PATTERNS.windowsAbsolute.test(value)) {
    return {
      path,
      code: 'INVALID_ENTRY_PATH',
      message: 'must not be an absolute filesystem path',
    };
  }

  if (value.startsWith('/') || value.startsWith('\\')) {
    return {
      path,
      code: 'INVALID_ENTRY_PATH',
      message: 'must not be a root-absolute path (e.g. "/index.html")',
    };
  }

  return null;
}
