import { OPENMINI_SHARED_VERSION } from '@openmini/shared';

/**
 * Placeholder export — the mini-app-facing SDK (capability APIs exposed to
 * sandboxed mini-apps) is implemented in a later phase.
 */
export const OPENMINI_SDK_VERSION = '0.1.0';

export function getSdkInfo(): { sdkVersion: string; sharedVersion: string } {
  return {
    sdkVersion: OPENMINI_SDK_VERSION,
    sharedVersion: OPENMINI_SHARED_VERSION,
  };
}
