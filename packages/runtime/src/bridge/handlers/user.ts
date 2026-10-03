import { ANONYMOUS_USER_PROFILE } from '@openmini/shared';
import type { UserProfile } from '@openmini/shared';
import type { PackageProvenance } from '../../sandbox/types';
import type { BridgeHandlerContext, BridgeMethodHandler } from '../types';

/**
 * Retained spelling of the profile shape, which now lives in
 * `@openmini/shared` alongside the rest of the bridge wire format.
 *
 * @deprecated Prefer `UserProfile`. Kept because it is exported from
 * `@openmini/runtime`'s public surface, and Phase 12 is not the phase that
 * breaks a published type for a rename.
 */
export type StubUserProfile = UserProfile;

export interface UserHandlerOptions {
  /**
   * The person using the host, as the host understands them.
   *
   * Supplied by the host at bridge-creation time and owned by it — the same
   * shape `createStorageHandlers({ provider })` and
   * `createNetworkHandlers({ allowInsecureLoopback })` already use. There is
   * no protocol for *obtaining* this: a host with an authenticated session
   * of its own passes what it knows, and a host without one passes nothing.
   * Phase 12 ships no login flow and no identity provider.
   *
   * Its lifetime is the dispatcher's. Nothing is written to storage, so
   * there is nothing to delete, and `sandbox.destroy()` is a complete
   * sign-out. That is what keeps this phase clear of Phase 10's no-delete
   * invariant rather than merely respectful of it.
   *
   * Omitted means the host has nobody to name, which every Mini App sees as
   * `ANONYMOUS_USER_PROFILE` — the same value it would see if it were not
   * entitled to an identity at all. See that constant for why the two are
   * deliberately indistinguishable.
   */
  readonly profile?: UserProfile;
}

/**
 * Decides what a Mini App is told about the person using the host.
 *
 * Pure, and separate from the handler on purpose: this is the whole of the
 * policy, so it can be reviewed and tested on values — the shape
 * `deriveStorageScope` uses for the same reason.
 *
 * **Only a verified package learns anything.** Identity is told to a
 * package whose own identity the host established, and to nothing else.
 * An unverified package shares the origin storage tier with every other
 * unsigned package served from that origin — `bridge.md` already says not
 * to put anything there whose disclosure to a neighbour would matter — so
 * handing it the user's identity would be disclosing to exactly that
 * neighbourhood.
 *
 * The condition is `identity.verified`, and deliberately **not**
 * `provenance !== undefined`. Those differ precisely where it matters: a
 * package loaded from a URL and found to be unsigned, or signed by an
 * untrusted key, has provenance and is not verified. Testing for presence
 * would admit the whole origin tier while still passing every
 * fixture-shaped test, which is why each unverified reason has its own
 * case below rather than sharing one.
 *
 * Three different reasons return one value, and that is load-bearing
 * rather than incidental — see `ANONYMOUS_USER_PROFILE`. "You are not
 * trusted", "no package was loaded" and "nobody is signed in" must be
 * indistinguishable, or a Mini App can probe the host: learn that someone
 * is signed in without being allowed to know who.
 *
 * This is the *second* gate. The first is the manifest's `user` permission,
 * enforced by the dispatcher before any handler runs, and the two are
 * independent: being allowed to ask is not being entitled to an answer, and
 * a verified package that never declared `user` is refused rather than
 * handed nulls.
 */
export function resolveUserProfile(
  provenance: PackageProvenance | undefined,
  hostProfile: UserProfile | undefined,
): UserProfile {
  if (provenance?.identity.verified !== true) {
    return ANONYMOUS_USER_PROFILE;
  }
  // A verified package, and the host may still have nobody to name. That
  // is not a refusal and must not look like one.
  return hostProfile ?? ANONYMOUS_USER_PROFILE;
}

/**
 * `user.*` — what a Mini App may learn about the person using the host.
 *
 * The namespace is still gated by the manifest's `user` permission, exactly
 * as it was in Phase 4. Phase 12 adds a second, independent gate inside
 * `resolveUserProfile`: being allowed to *ask* is not the same as being
 * entitled to an *answer*. See docs/security/bridge.md.
 */
export function createUserHandlers(
  options: UserHandlerOptions = {},
): Record<string, BridgeMethodHandler> {
  return {
    getProfile(_params: unknown, ctx: BridgeHandlerContext): UserProfile {
      return resolveUserProfile(ctx.provenance, options.profile);
    },
  };
}
