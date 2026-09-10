import { describe, expect, it } from 'vitest';
import { OPENMINI_CLI_VERSION } from './index';

describe('@openmini/cli', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_CLI_VERSION).toBe('0.1.0');
  });
});
