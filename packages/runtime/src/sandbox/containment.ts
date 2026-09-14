export type ContainmentFailureReason =
  | 'EMPTY'
  | 'ABSOLUTE_PATH'
  | 'SCHEME_LIKE'
  | 'TRAVERSAL'
  | 'INVALID_SEGMENT';

export type ContainmentResult =
  | { ok: true; segments: string[] }
  | { ok: false; reason: ContainmentFailureReason };

// Windows drive-letter/UNC forms, checked before the generic scheme check so
// "C:\x" is reported as ABSOLUTE_PATH rather than (also correctly, but less
// clearly) SCHEME_LIKE.
const WINDOWS_ABSOLUTE_PATTERN = /^[a-zA-Z]:[\\/]/;
const WINDOWS_UNC_PATTERN = /^\\\\/;
// Requires "://" (not just ":") so a Windows drive letter is never mistaken
// for a URL scheme — mirrors @openmini/manifest's entry-path rule.
const URL_SCHEME_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Decodes a single path segment exactly once. Returns null if the segment is
 * percent-encoded more than once (decoding again still changes the result),
 * which is rejected outright rather than looped, to defend against
 * double-encoded traversal (e.g. `%252e%252e`).
 */
function decodeSegmentOnce(segment: string): string | null {
  let decodedOnce: string;
  try {
    decodedOnce = decodeURIComponent(segment);
  } catch {
    return null;
  }

  try {
    const decodedTwice = decodeURIComponent(decodedOnce);
    if (decodedTwice !== decodedOnce) {
      return null;
    }
  } catch {
    // decodedOnce contains no further percent-escapes worth re-decoding —
    // not itself a failure.
  }

  return decodedOnce;
}

/**
 * Pure, synchronous containment check for a manifest `entry`-style relative
 * path. Independent of, and in addition to, @openmini/manifest's existing
 * string-shape check (untrusted input stays untrusted even across our own
 * module boundaries) — this is the runtime's own defense-in-depth layer,
 * exercised at resource-resolution time rather than manifest-parse time.
 *
 * Does NOT perform filesystem operations (no symlink resolution, no
 * case-folding) — those are the responsibility of any future
 * filesystem-backed MiniAppResourceProvider implementation.
 */
export function resolveContainedPath(relative: string): ContainmentResult {
  if (typeof relative !== 'string' || relative.trim() === '') {
    return { ok: false, reason: 'EMPTY' };
  }

  if (WINDOWS_ABSOLUTE_PATTERN.test(relative) || WINDOWS_UNC_PATTERN.test(relative)) {
    return { ok: false, reason: 'ABSOLUTE_PATH' };
  }

  if (URL_SCHEME_PATTERN.test(relative) || relative.startsWith('//')) {
    return { ok: false, reason: 'SCHEME_LIKE' };
  }

  if (relative.startsWith('/') || relative.startsWith('\\')) {
    return { ok: false, reason: 'ABSOLUTE_PATH' };
  }

  const rawSegments = relative.split(/[\\/]+/).filter((segment) => segment.length > 0);
  const segments: string[] = [];

  for (const raw of rawSegments) {
    const decoded = decodeSegmentOnce(raw);
    if (decoded === null) {
      return { ok: false, reason: 'INVALID_SEGMENT' };
    }
    if (decoded === '..') {
      return { ok: false, reason: 'TRAVERSAL' };
    }
    if (decoded === '.') {
      continue;
    }
    if (decoded.includes('/') || decoded.includes('\\')) {
      // A decode step introduced a new separator — treat as a traversal
      // attempt rather than trusting the re-split result.
      return { ok: false, reason: 'INVALID_SEGMENT' };
    }
    segments.push(decoded);
  }

  if (segments.length === 0) {
    return { ok: false, reason: 'EMPTY' };
  }

  return { ok: true, segments };
}
