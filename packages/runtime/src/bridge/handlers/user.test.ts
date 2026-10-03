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
 * Phase 12 W3. The host supplies a profile; only a verified package is told
 * it. Every other outcome is the one shared anonymous constant, and the
 * reasons are deliberately indistinguishable from each other.
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

describe('only a verified package learns who the user is', () => {
  it('hands the host profile to a verified package', async () => {
    const result = getProfile({ profile: HOST_PROFILE }, contextWith(verified));

    expect(result).toEqual(HOST_PROFILE);
  });

  it('withholds it from a package that was loaded but not verified', async () => {
    // `unsigned` and `untrusted-key` are separate cases on purpose: both
    // carry provenance, so a gate written as `provenance !== undefined`
    // would admit both while still passing every fixture-shaped test.
    expect(getProfile({ profile: HOST_PROFILE }, contextWith(unsigned))).toEqual(
      ANONYMOUS_USER_PROFILE,
    );
    expect(getProfile({ profile: HOST_PROFILE }, contextWith(untrusted))).toEqual(
      ANONYMOUS_USER_PROFILE,
    );
  });

  it('withholds it when no package was loaded at all', async () => {
    // The embedded tier: a static fixture or a test. Nothing was checked,
    // so nothing is established, so nothing is told.
    expect(getProfile({ profile: HOST_PROFILE }, contextWith(undefined))).toEqual(
      ANONYMOUS_USER_PROFILE,
    );
  });

  it('gives a verified package the anonymous profile when the host has nobody to name', async () => {
    // Not a refusal, and it must not look like one.
    expect(getProfile({}, contextWith(verified))).toEqual(ANONYMOUS_USER_PROFILE);
  });

  it('does not depend on which registered key signed the package', async () => {
    // Rotation continuity, the same claim Phase 11 made for the storage
    // namespace: the entitlement follows the verified id, never the key.
    const rotated: PackageProvenance = {
      baseUrl: verified.baseUrl,
      identity: { verified: true, id: 'com.example.notes', keyId: 'KEY-B-SUCCESSOR' },
    };

    expect(resolveUserProfile(rotated, HOST_PROFILE)).toEqual(
      resolveUserProfile(verified, HOST_PROFILE),
    );
  });

  it('passes the host profile through unchanged rather than rebuilding it', async () => {
    expect(resolveUserProfile(verified, HOST_PROFILE)).toBe(HOST_PROFILE);
  });
});

describe('every reason for withholding is indistinguishable', () => {
  it('returns the one shared constant, by identity, for all four reasons', () => {
    // Invariant 2. If these differed at all -- a distinct object, an extra
    // field, a thrown error -- a Mini App could tell "you are not trusted"
    // apart from "nobody is signed in", and so probe the host for whether
    // a session exists without being entitled to know whose.
    expect(resolveUserProfile(unsigned, HOST_PROFILE)).toBe(ANONYMOUS_USER_PROFILE);
    expect(resolveUserProfile(untrusted, HOST_PROFILE)).toBe(ANONYMOUS_USER_PROFILE);
    expect(resolveUserProfile(undefined, HOST_PROFILE)).toBe(ANONYMOUS_USER_PROFILE);
    expect(resolveUserProfile(verified, undefined)).toBe(ANONYMOUS_USER_PROFILE);
  });

  it('never reports why it withheld', async () => {
    // The value carries no reason code, no extra key, nothing to branch on.
    const withheld = getProfile({ profile: HOST_PROFILE }, contextWith(untrusted));

    expect(Object.keys(withheld as object).sort()).toEqual(['displayName', 'id']);
  });

  it('does not throw for an unverified package', async () => {
    // A rejection would be as distinguishable as a marker value, and would
    // additionally tell the package that the capability exists at all.
    expect(() => getProfile({ profile: HOST_PROFILE }, contextWith(unsigned))).not.toThrow();
  });
});

describe('the withheld value', () => {
  it('cannot be mutated by a handler caller into something another caller sees', () => {
    const first = getProfile(undefined, contextWith(verified)) as UserProfile;
    expect(() => {
      (first as { id: string | null }).id = 'injected';
    }).toThrow();

    expect(getProfile(undefined, contextWith(verified))).toEqual({ id: null, displayName: null });
  });
});
