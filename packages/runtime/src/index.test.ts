import { describe, expect, it } from 'vitest';
import { getRuntimeInfo, OPENMINI_RUNTIME_VERSION } from './index';

describe('@openmini/runtime', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_RUNTIME_VERSION).toBe('0.1.0');
  });

  it('reports runtime and shared versions', () => {
    const info = getRuntimeInfo();
    expect(info.runtimeVersion).toBe('0.1.0');
    expect(info.sharedVersion).toBe('0.1.0');
  });
});
