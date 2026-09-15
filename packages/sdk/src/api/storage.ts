import type { BridgeClient } from '../bridge/client';

export interface OpenMiniStorageApi {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function createStorageApi(client: BridgeClient): OpenMiniStorageApi {
  return {
    get: (key) => client.request('storage.get', { key }) as Promise<string | null>,
    set: (key, value) => client.request('storage.set', { key, value }) as Promise<void>,
  };
}
