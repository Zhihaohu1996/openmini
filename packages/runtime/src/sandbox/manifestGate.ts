import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import type { OpenMiniManifest } from '@openmini/manifest';

export type ManifestGateResult =
  { ok: true; manifest: OpenMiniManifest } | { ok: false; reason: string };

/**
 * Validates raw manifest JSON before any sandbox is created. This is a thin
 * wrapper around @openmini/manifest's own validator (single source of
 * truth) — the runtime never re-implements manifest validation, it only
 * gates sandbox creation on the result.
 */
export function gateManifest(raw: string): ManifestGateResult {
  const result = parseManifest(raw);
  if (!result.valid) {
    return { ok: false, reason: formatManifestIssues(result.issues) };
  }
  return { ok: true, manifest: result.manifest };
}
