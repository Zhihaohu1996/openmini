import { describe, expect, it } from 'vitest';
import { ANONYMOUS_USER_PROFILE } from './user';

/**
 * Phase 12 W1. The profile shape, shared so the runtime and the SDK cannot
 * describe one wire format two ways. Nothing reads a host profile yet — W2
 * threads one and W3 is where a verified package starts receiving it.
 */

describe('ANONYMOUS_USER_PROFILE', () => {
  it('is nulls, which is what a Mini App receives when it is entitled to nothing', () => {
    expect(ANONYMOUS_USER_PROFILE).toEqual({ id: null, displayName: null });
  });

  it('is frozen, because it is handed to callers rather than copied', () => {
    // A shared mutable constant would let one caller change what every
    // later caller sees -- including, once W3 lands, changing what an
    // unverified package is told.
    expect(Object.isFrozen(ANONYMOUS_USER_PROFILE)).toBe(true);
  });

  it('is one value, so every reason for withholding looks the same', () => {
    // The property W3 depends on. "You are not trusted", "no package was
    // loaded" and "nobody is signed in" must be indistinguishable to a Mini
    // App, or the absence of a profile becomes a channel for probing the
    // host. Pinned here, at the definition, rather than only at the three
    // call sites that will return it.
    expect(Object.keys(ANONYMOUS_USER_PROFILE).sort()).toEqual(['displayName', 'id']);
  });
});
