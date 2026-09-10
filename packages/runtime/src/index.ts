import { OPENMINI_SHARED_VERSION } from '@openmini/shared';

/**
 * Placeholder export — the actual mini-app runtime (sandboxing, lifecycle,
 * permission enforcement, JS bridge) is implemented in a later phase.
 */
export const OPENMINI_RUNTIME_VERSION = '0.1.0';

export function getRuntimeInfo(): { runtimeVersion: string; sharedVersion: string } {
  return {
    runtimeVersion: OPENMINI_RUNTIME_VERSION,
    sharedVersion: OPENMINI_SHARED_VERSION,
  };
}
