import { ManifestValidationError } from './errors';
import { validateManifest } from './validateManifest';
import type { ManifestValidationResult, OpenMiniManifest } from './types';

export function parseManifest(raw: string): ManifestValidationResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      valid: false,
      issues: [{ path: '', code: 'MALFORMED_JSON', message: `invalid JSON: ${detail}` }],
    };
  }

  return validateManifest(parsed);
}

export function assertValidManifest(input: unknown): OpenMiniManifest {
  const result = validateManifest(input);
  if (!result.valid) {
    throw new ManifestValidationError(result.issues);
  }
  return result.manifest;
}
