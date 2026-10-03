import { ANONYMOUS_USER_PROFILE } from '@openmini/shared';
import type { UserProfile } from '@openmini/shared';
import type { BridgeMethodHandler } from '../types';

/**
 * Retained spelling of the profile shape, which now lives in
 * `@openmini/shared` alongside the rest of the bridge wire format.
 *
 * @deprecated Prefer `UserProfile`. Kept because it is exported from
 * `@openmini/runtime`'s public surface, and Phase 12 is not the phase that
 * breaks a published type for a rename.
 */
export type StubUserProfile = UserProfile;

/**
 * Phase 4's only user implementation: a static stub. No real identity/auth
 * system exists yet — this proves the bridge plumbing only. See
 * docs/security/bridge.md.
 */
export function createUserHandlers(): Record<string, BridgeMethodHandler> {
  return {
    getProfile(): UserProfile {
      return ANONYMOUS_USER_PROFILE;
    },
  };
}
