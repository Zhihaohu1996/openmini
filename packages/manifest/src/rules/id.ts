import { ID_PATTERN, MAX_ID_LENGTH } from '../constants';
import type { ManifestIssue } from '../types';

export function checkId(value: unknown, path: string): ManifestIssue | null {
  if (typeof value !== 'string') {
    return { path, code: 'INVALID_TYPE', message: 'must be a string' };
  }

  // Length before shape. A very long id matches ID_PATTERN perfectly well —
  // the pattern constrains characters, not size — and running a regex over
  // an unbounded string to then report a shape error would both do the work
  // and give the less useful message. This keeps `openmini.schema.json`'s
  // `maxLength` and this check saying the same thing; schema.test.ts pins
  // that they agree.
  if (value.length > MAX_ID_LENGTH) {
    return {
      path,
      code: 'INVALID_ID',
      message: `must be at most ${MAX_ID_LENGTH} characters`,
    };
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
