import { describe, expect, it } from 'vitest';
import { OPENMINI_SHARED_VERSION } from './index';

describe('@openmini/shared', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_SHARED_VERSION).toBe('0.1.0');
  });
});
