import type { UserProfile } from '@openmini/shared';
import type { BridgeClient } from '../bridge/client';

/**
 * Retained spelling of the profile shape, which now lives in
 * `@openmini/shared` so that the SDK and the runtime describe one wire
 * format rather than two structurally identical ones.
 *
 * @deprecated Prefer `UserProfile`.
 */
export type OpenMiniUserProfile = UserProfile;

export interface OpenMiniUserApi {
  getProfile(): Promise<UserProfile>;
}

export function createUserApi(client: BridgeClient): OpenMiniUserApi {
  return {
    getProfile: () => client.request('user.getProfile', undefined) as Promise<UserProfile>,
  };
}
