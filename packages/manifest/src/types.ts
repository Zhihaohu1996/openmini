import type { MANIFEST_PERMISSIONS, SUPPORTED_SCHEMA_VERSION } from './constants';

export type ManifestPermission = (typeof MANIFEST_PERMISSIONS)[number];

export interface OpenMiniManifest {
  schemaVersion: typeof SUPPORTED_SCHEMA_VERSION;
  id: string;
  name: string;
  version: string;
  entry: string;
  permissions: ManifestPermission[];
}

export type ManifestIssueCode =
  | 'MALFORMED_JSON'
  | 'INVALID_ROOT_TYPE'
  | 'MISSING_FIELD'
  | 'UNKNOWN_FIELD'
  | 'INVALID_TYPE'
  | 'UNSUPPORTED_SCHEMA_VERSION'
  | 'INVALID_ID'
  | 'INVALID_NAME'
  | 'INVALID_VERSION'
  | 'INVALID_ENTRY_PATH'
  | 'UNKNOWN_PERMISSION'
  | 'DUPLICATE_PERMISSION';

export interface ManifestIssue {
  path: string;
  code: ManifestIssueCode;
  message: string;
}

export type ManifestValidationResult =
  | { valid: true; manifest: OpenMiniManifest }
  | { valid: false; issues: ManifestIssue[] };
