import { describe, expect, it } from 'vitest';
import { checkVersion } from './semver';

describe('checkVersion', () => {
  it.each([
    '1.0.0',
    '0.1.0',
    '1.0.0-alpha',
    '1.0.0-alpha.1',
    '1.0.0+build.123',
    '1.0.0-beta.2+sha.abc',
  ])('accepts valid semver %s', (value) => {
    expect(checkVersion(value, 'version')).toBeNull();
  });

  it.each(['1', '1.0', 'v1.0.0', '01.0.0'])('rejects invalid semver %s', (value) => {
    expect(checkVersion(value, 'version')).toMatchObject({ code: 'INVALID_VERSION' });
  });

  it('rejects non-string values', () => {
    expect(checkVersion(1.0, 'version')).toMatchObject({ code: 'INVALID_TYPE' });
  });
});
