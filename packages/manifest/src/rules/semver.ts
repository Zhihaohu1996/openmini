import { SEMVER_PATTERN } from '../constants';
import type { ManifestIssue } from '../types';

export function checkVersion(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'string') {
    return { path, code: 'INVALID_TYPE', message: 'must be a string' };
  }

  if (!SEMVER_PATTERN.test(value)) {
    return { path, code: 'INVALID_VERSION', message: 'must be a valid semantic version' };
  }

  return null;
}
