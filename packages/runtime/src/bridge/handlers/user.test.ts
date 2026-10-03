import { ANONYMOUS_USER_PROFILE } from '@openmini/shared';
import type { UserProfile } from '@openmini/shared';
import { describe, expect, it } from 'vitest';
import type { PackageProvenance } from '../../sandbox/types';
import type { BridgeHandlerContext } from '../types';
import { createUserHandlers, resolveUserProfile } from './user';

describe('createUserHandlers', () => {
  it('returns a static stub profile', () => {
    const handlers = createUserHandlers();
    expect(handlers.getProfile?.(undefined, { sandbox: {}, manifest: {} } as never)).toEqual({
      id: null,
      displayName: null,
    });
  });
});

/**
 * Phase 12 W2. The host profile and `ctx.provenance` both reach the
 * decision, and the decision ignores them. W3 is the single commit where a
 * verified package starts receiving the profile.
 */

const HOST_PROFILE: UserProfile = { id: 'u_1138', displayName: 'Ada' };

const contextWith = (provenance?: PackageProvenance): BridgeHandlerContext =>
  ({ sandbox: {}, manifest: {}, provenance }) as unknown as BridgeHandlerContext;

const verified: PackageProvenance = {
  baseUrl: 'https://cdn.example.com/apps/notes/',
  identity: { verified: true, id: 'com.example.notes', keyId: 'KEY-A' },
};
const unsigned: PackageProvenance = {
  baseUrl: 'https://cdn.example.com/apps/notes/',
  identity: { verified: false, reason: 'unsigned' },
};
const untrusted: PackageProvenance = {
  baseUrl: 'https://cdn.example.com/apps/notes/',
  identity: { verified: false, reason: 'untrusted-key' },
};

const getProfile = (options: Parameters<typeof createUserHandlers>[0], ctx: BridgeHandlerContext) =>
  createUserHandlers(options).getProfile?.(undefined, ctx);

describe('the host profile reaches the handler', () => {
  it('still accepts no options at all', () => {
    // Every existing caller passes nothing, including `createDefaultHandlers`.
    expect(getProfile(undefined, contextWith())).toEqual(ANONYMOUS_USER_PROFILE);
  });

  it('accepts a host profile without anyone having to supply provenance', () => {
    expect(getProfile({ profile: HOST_PROFILE }, contextWith())).toEqual(ANONYMOUS_USER_PROFILE);
  });
});

describe('what W2 deliberately does not do yet', () => {
  it('does not yet hand a verified package the host profile', () => {
    // Pinned rather than left implicit, the way Phase 11 W2 pinned a revoked
    // key still loading: W3 is the one commit where this flips, and breaking
    // this test is how it announces itself.
    //
    // Nothing can reach a changed outcome in a running host today — no host
    // supplies a profile until W5 — so this is a property of the threading,
    // not a gap a deployed host has.
    expect(getProfile({ profile: HOST_PROFILE }, contextWith(verified))).toEqual(
      ANONYMOUS_USER_PROFILE,
    );
  });

  it('resolves identically for every provenance shape', () => {
    // The shapes W3 must start telling apart. Today they agree, which is
    // what makes W3's diff the whole of the behavioural change.
    const resolved = [undefined, verified, unsigned, untrusted].map((provenance) =>
      resolveUserProfile(provenance, HOST_PROFILE),
    );

    expect(resolved).toEqual([
      ANONYMOUS_USER_PROFILE,
      ANONYMOUS_USER_PROFILE,
      ANONYMOUS_USER_PROFILE,
      ANONYMOUS_USER_PROFILE,
    ]);
  });

  it('ignores the host profile whether or not one was supplied', () => {
    expect(resolveUserProfile(verified, HOST_PROFILE)).toEqual(
      resolveUserProfile(verified, undefined),
    );
  });
});

describe('the withheld value', () => {
  it('is the shared constant itself, not a copy of its fields', () => {
    // Identity, not equality. Three call sites will return this in W3 --
    // unverified, no provenance, no host profile -- and returning the one
    // frozen constant is what stops them drifting into three subtly
    // different "anonymous" objects that a Mini App could tell apart.
    expect(resolveUserProfile(verified, HOST_PROFILE)).toBe(ANONYMOUS_USER_PROFILE);
    expect(getProfile({ profile: HOST_PROFILE }, contextWith(unsigned))).toBe(
      ANONYMOUS_USER_PROFILE,
    );
  });

  it('cannot be mutated by a handler caller into something another caller sees', () => {
    const first = getProfile(undefined, contextWith(verified)) as UserProfile;
    expect(() => {
      (first as { id: string | null }).id = 'injected';
    }).toThrow();

    expect(getProfile(undefined, contextWith(verified))).toEqual({ id: null, displayName: null });
  });
});
