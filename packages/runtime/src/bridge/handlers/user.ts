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
 * policy, so it can be reviewed and tested on values before anything
 * depends on it — the shape `deriveStorageScope` uses for the same reason.
 *
 * **Phase 12 W2: both inputs the decision needs arrive here, and neither
 * decides anything yet.** W3 is the single commit where a verified package
 * starts receiving `hostProfile`, and splitting them keeps that behavioural
 * change to one reviewable diff instead of burying it inside the threading.
 * A test pins this provisional state, so W3 announces itself by breaking it
 * — the same way Phase 11 W2 pinned a revoked key still loading.
 */
export function resolveUserProfile(
  provenance: PackageProvenance | undefined,
  hostProfile: UserProfile | undefined,
): UserProfile {
  void provenance;
  void hostProfile;
  return ANONYMOUS_USER_PROFILE;
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
