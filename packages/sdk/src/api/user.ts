import type { BridgeClient } from '../bridge/client';

export interface OpenMiniUserProfile {
  id: string | null;
  displayName: string | null;
}

export interface OpenMiniUserApi {
  getProfile(): Promise<OpenMiniUserProfile>;
}

export function createUserApi(client: BridgeClient): OpenMiniUserApi {
  return {
    getProfile: () => client.request('user.getProfile', undefined) as Promise<OpenMiniUserProfile>,
  };
}
