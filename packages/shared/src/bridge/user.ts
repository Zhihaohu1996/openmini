/**
 * The shape of `user.getProfile()`, defined once.
 *
 * It lived in two places until Phase 12: `StubUserProfile` in the runtime's
 * handler and `OpenMiniUserProfile` in the SDK, structurally identical and
 * related by nothing. That was tolerable while the value was a constant
 * both sides hardcoded. It stops being tolerable once the host supplies the
 * value and the runtime decides whether to pass it on, because then the two
 * declarations describe one wire format — and the bridge protocol already
 * lives here for exactly that reason.
 */

export interface UserProfile {
  /**
   * Stable, host-assigned identifier for the person using the host, or
   * `null` when there is nobody to name.
   *
   * It identifies a user *to this host*. It is not a global identity, not a
   * credential, and not a bearer of any authority: a Mini App cannot
   * present it back to the host to prove anything, and nothing in the
   * runtime accepts it as an input.
   */
  readonly id: string | null;
  /** Human-readable name for display, or `null`. Never used as a key. */
  readonly displayName: string | null;
}

/**
 * What a Mini App receives when it is not entitled to an identity.
 *
 * A single definition on purpose. This is the value for *every* reason a
 * profile is not handed over — the package is unverified, the sandbox came
 * from a fixture with no package load at all, or the host simply has nobody
 * signed in — and those cases must be indistinguishable to the Mini App.
 *
 * If they were distinguishable, a package could probe the host: learn that
 * someone is signed in without being allowed to know who, or tell "you are
 * not trusted" apart from "nobody is here". Collapsing them is the same
 * call the dispatcher makes when it answers `PERMISSION_DENIED` identically
 * for an unpermitted namespace and one that does not exist, so that a
 * caller learns nothing from the refusal.
 *
 * Frozen because it is handed to callers directly rather than copied.
 */
export const ANONYMOUS_USER_PROFILE: UserProfile = Object.freeze({
  id: null,
  displayName: null,
});
