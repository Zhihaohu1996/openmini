import { MAX_NAME_LENGTH, SUPPORTED_SCHEMA_VERSION } from './constants';
import { checkEntryPath } from './rules/entryPath';
import { checkId } from './rules/id';
import { checkNetwork } from './rules/networkDomains';
import { checkPermissions } from './rules/permissions';
import { checkVersion } from './rules/semver';
import type { ManifestIssue, ManifestValidationResult, OpenMiniManifest } from './types';

const REQUIRED_FIELDS = ['schemaVersion', 'id', 'name', 'version', 'entry', 'permissions'] as const;
/** Present-or-absent by design; `network` is gated by the `network` permission instead. */
const OPTIONAL_FIELDS = ['network'] as const;
const KNOWN_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS] as const;

function checkSchemaVersion(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    return { path, code: 'INVALID_TYPE', message: 'must be an integer' };
  }

  if (value !== SUPPORTED_SCHEMA_VERSION) {
    return {
      path,
      code: 'UNSUPPORTED_SCHEMA_VERSION',
      message: `unsupported schemaVersion ${value}; only ${SUPPORTED_SCHEMA_VERSION} is supported`,
    };
  }

  return null;
}

function checkName(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'string') {
    return { path, code: 'INVALID_TYPE', message: 'must be a string' };
  }

  if (value.trim().length === 0) {
    return { path, code: 'INVALID_NAME', message: 'must not be empty' };
  }

  if (value.length > MAX_NAME_LENGTH) {
    return {
      path,
      code: 'INVALID_NAME',
      message: `must be at most ${MAX_NAME_LENGTH} characters`,
    };
  }

  return null;
}

export function validateManifest(input: unknown): ManifestValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      valid: false,
      issues: [
        { path: '', code: 'INVALID_ROOT_TYPE', message: 'manifest must be a JSON object' },
      ],
    };
  }

  const record = input as Record<string, unknown>;
  const issues: ManifestIssue[] = [];

  for (const field of REQUIRED_FIELDS) {
    if (!(field in record)) {
      issues.push({ path: field, code: 'MISSING_FIELD', message: 'is required' });
      continue;
    }

    const value = record[field];

    switch (field) {
      case 'schemaVersion': {
        const issue = checkSchemaVersion(value, field);
        if (issue) issues.push(issue);
        break;
      }
      case 'id': {
        const issue = checkId(value, field);
        if (issue) issues.push(issue);
        break;
      }
      case 'name': {
        const issue = checkName(value, field);
        if (issue) issues.push(issue);
        break;
      }
      case 'version': {
        const issue = checkVersion(value, field);
        if (issue) issues.push(issue);
        break;
      }
      case 'entry': {
        const issue = checkEntryPath(value, field);
        if (issue) issues.push(issue);
        break;
      }
      case 'permissions': {
        issues.push(...checkPermissions(value, field));
        break;
      }
    }
  }

  issues.push(...checkNetwork(record.network, 'network', record.permissions));

  for (const key of Object.keys(record)) {
    if (!(KNOWN_FIELDS as readonly string[]).includes(key)) {
      issues.push({ path: key, code: 'UNKNOWN_FIELD', message: 'unknown field' });
    }
  }

  if (issues.length > 0) {
    return { valid: false, issues };
  }

  const manifest: OpenMiniManifest = {
    schemaVersion: record.schemaVersion as typeof SUPPORTED_SCHEMA_VERSION,
    id: record.id as string,
    name: record.name as string,
    version: record.version as string,
    entry: record.entry as string,
    permissions: record.permissions as OpenMiniManifest['permissions'],
  };

  if (record.network !== undefined) {
    manifest.network = { domains: (record.network as { domains: string[] }).domains };
  }

  return { valid: true, manifest };
}
