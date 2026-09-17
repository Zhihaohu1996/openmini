import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface ValidateResult {
  ok: boolean;
  /** Human-readable report, already formatted for printing. */
  report: string;
}

const MANIFEST_FILENAME = 'openmini.json';

/**
 * Validates a package or authoring project's manifest.
 *
 * Deliberately adds no validation logic of its own: @openmini/manifest is the
 * single source of truth, and its existing parser and issue formatter are
 * reused so the CLI, the host and any future tooling all render identical
 * error text.
 */
export async function validatePackage(target: string): Promise<ValidateResult> {
  const path = target.endsWith('.json') ? target : join(target, MANIFEST_FILENAME);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return { ok: false, report: `cannot read manifest: ${path}` };
  }

  const result = parseManifest(raw);
  if (result.valid) {
    return { ok: true, report: `${path}: valid (${result.manifest.id} ${result.manifest.version})` };
  }

  return { ok: false, report: `${path}:\n${formatManifestIssues(result.issues)}` };
}
