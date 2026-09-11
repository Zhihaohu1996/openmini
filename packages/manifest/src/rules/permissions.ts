import { MANIFEST_PERMISSIONS } from '../constants';
import type { ManifestIssue, ManifestPermission } from '../types';

function isKnownPermission(value: string): value is ManifestPermission {
  return (MANIFEST_PERMISSIONS as readonly string[]).includes(value);
}

export function checkPermissions(value: unknown, path: string): ManifestIssue[] {
  if (!Array.isArray(value)) {
    return [{ path, code: 'INVALID_TYPE', message: 'must be an array' }];
  }

  const issues: ManifestIssue[] = [];
  const seen = new Set<string>();

  value.forEach((entry, index) => {
    const entryPath = `${path}[${index}]`;

    if (typeof entry !== 'string') {
      issues.push({ path: entryPath, code: 'INVALID_TYPE', message: 'must be a string' });
      return;
    }

    if (!isKnownPermission(entry)) {
      issues.push({
        path: entryPath,
        code: 'UNKNOWN_PERMISSION',
        message: `unknown permission "${entry}"`,
      });
      return;
    }

    if (seen.has(entry)) {
      issues.push({
        path: entryPath,
        code: 'DUPLICATE_PERMISSION',
        message: `duplicate permission "${entry}"`,
      });
      return;
    }

    seen.add(entry);
  });

  return issues;
}
