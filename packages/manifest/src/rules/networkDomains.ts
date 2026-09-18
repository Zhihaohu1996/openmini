import { NETWORK_DOMAIN_IPV6_PATTERN, NETWORK_DOMAIN_PATTERN } from '../constants';
import type { ManifestIssue } from '../types';

const NETWORK_PERMISSION = 'network';

function isDeclarableDomain(value: string): boolean {
  return NETWORK_DOMAIN_PATTERN.test(value) || NETWORK_DOMAIN_IPV6_PATTERN.test(value);
}

/**
 * Validates the optional `network` declaration against `permissions`.
 *
 * The two must agree in both directions: declaring the `network` permission
 * without saying which hosts it covers would be a permission with no
 * meaning, and listing hosts without the permission would be a list the
 * runtime never consults. Either mismatch is far more likely to be an
 * authoring mistake than an intent, so both are rejected rather than
 * silently normalized.
 */
export function checkNetwork(value: unknown, path: string, permissions: unknown): ManifestIssue[] {
  const declaresPermission = Array.isArray(permissions) && permissions.includes(NETWORK_PERMISSION);

  if (value === undefined) {
    if (declaresPermission) {
      return [
        {
          path,
          code: 'MISSING_NETWORK_DECLARATION',
          message: `is required when "permissions" includes "${NETWORK_PERMISSION}"`,
        },
      ];
    }
    return [];
  }

  if (!declaresPermission) {
    return [
      {
        path,
        code: 'UNEXPECTED_NETWORK_DECLARATION',
        message: `is only allowed when "permissions" includes "${NETWORK_PERMISSION}"`,
      },
    ];
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return [{ path, code: 'INVALID_TYPE', message: 'must be an object' }];
  }

  const record = value as Record<string, unknown>;
  const issues: ManifestIssue[] = [];

  for (const key of Object.keys(record)) {
    if (key !== 'domains') {
      issues.push({ path: `${path}.${key}`, code: 'UNKNOWN_FIELD', message: 'unknown field' });
    }
  }

  if (!('domains' in record)) {
    return [...issues, { path: `${path}.domains`, code: 'MISSING_FIELD', message: 'is required' }];
  }

  const domains = record.domains;
  if (!Array.isArray(domains)) {
    return [
      ...issues,
      { path: `${path}.domains`, code: 'INVALID_TYPE', message: 'must be an array' },
    ];
  }

  const seen = new Set<string>();
  domains.forEach((entry, index) => {
    const entryPath = `${path}.domains[${index}]`;

    if (typeof entry !== 'string') {
      issues.push({ path: entryPath, code: 'INVALID_TYPE', message: 'must be a string' });
      return;
    }

    if (!isDeclarableDomain(entry)) {
      issues.push({
        path: entryPath,
        code: 'INVALID_NETWORK_DOMAIN',
        message: `"${entry}" is not a valid lowercase hostname (IPv6 must be bracketed, e.g. "[::1]")`,
      });
      return;
    }

    if (seen.has(entry)) {
      issues.push({
        path: entryPath,
        code: 'DUPLICATE_NETWORK_DOMAIN',
        message: `duplicate domain "${entry}"`,
      });
      return;
    }

    seen.add(entry);
  });

  return issues;
}
