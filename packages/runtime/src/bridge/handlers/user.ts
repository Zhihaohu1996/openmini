import type { BridgeMethodHandler } from '../types';

export interface StubUserProfile {
  id: string | null;
  displayName: string | null;
}

/**
 * Phase 4's only user implementation: a static stub. No real identity/auth
 * system exists yet — this proves the bridge plumbing only. See
 * docs/security/bridge.md.
 */
export function createUserHandlers(): Record<string, BridgeMethodHandler> {
  return {
    getProfile(): StubUserProfile {
      return { id: null, displayName: null };
    },
  };
}
