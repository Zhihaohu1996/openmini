import { ID_PATTERN } from '../constants';
import type { ManifestIssue } from '../types';

export function checkId(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'string') {
    return { path, code: 'INVALID_TYPE', message: 'must be a string' };
  }

  if (!ID_PATTERN.test(value)) {
    return {
      path,
      code: 'INVALID_ID',
      message:
        'must be a lowercase reverse-domain identifier with at least two segments (e.g. "com.example.app")',
    };
  }

  return null;
}
