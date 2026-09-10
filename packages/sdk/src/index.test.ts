import { describe, expect, it } from 'vitest';
import { getSdkInfo, OPENMINI_SDK_VERSION } from './index';

describe('@openmini/sdk', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_SDK_VERSION).toBe('0.1.0');
  });

  it('reports sdk and shared versions', () => {
    const info = getSdkInfo();
    expect(info.sdkVersion).toBe('0.1.0');
    expect(info.sharedVersion).toBe('0.1.0');
  });
});
