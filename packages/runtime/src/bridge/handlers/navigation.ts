import type { BridgeMethodHandler } from '../types';

/**
 * `navigation.close`'s actual close-then-destroy sequencing (the
 * closing-ack/fallback-timer logic from docs/security/bridge.md) is
 * special-cased directly in dispatcher.ts — scoped to this one method only,
 * not a generic mechanism any handler can trigger. This handler is
 * therefore intentionally a no-op: its only job is to exist so the normal
 * method-registration/permission checks succeed like any other method,
 * and to hand back the `undefined` result the generic response path posts.
 */
export function createNavigationHandlers(): Record<string, BridgeMethodHandler> {
  return {
    close(): undefined {
      return undefined;
    },
  };
}
