# Phase 10 — verified identity as a storage boundary (completed)

A record of what Phase 10 set out to do, what was decided, and what shipped.

For how the delivered system works, read [security/bridge.md](../security/bridge.md) — that is
the living document. This one is history, and is **not** updated as the code changes.

**Status:** closed out. See the CI evidence table below.

## Goal

Phase 9 threaded a `PackageProvenance` value to every bridge handler and left it unread. Phase 10
makes it load-bearing in exactly one place — storage scoping — and pays the migration debt Phase 9
deferred:

> "The storage handler deliberately does not consult `ctx.provenance`: gating storage on it would
> orphan the data of every currently-unsigned package, so it needs a migration story rather than a
> conditional."

The gap being closed was recorded verbatim in three documents and pinned by a test that asserted
the leak on purpose.

## Non-goals

- Trust config loading, revocation, expiry, rotation protocol, key distribution.
- Trust on first use, in any form.
- Widening `PackageProvenance`.
- Gating `network` / `navigation` / `user` on provenance.
- Real user/auth identity.
- Any destructive storage operation. No `delete`, no GC, no TTL — `MiniAppStorageProvider` still
  has no deletion on it, and that absence is the enforcement.
- Transactional storage. The non-atomic quota check survives unchanged.

## What shipped

### Scope derivation

| Provenance | Tier | Namespace |
|---|---|---|
| `identity.verified === true` | `verified` | `v1:id:<id>` |
| `identity.verified === false` | `origin` | `v1:origin:<origin>\|<id>` |
| `undefined` | `embedded` | bare `<id>` — unchanged from Phase 9 |
| — | reserved | `v1:meta:*`, unreachable by any derivation |

Three decisions, each because the obvious alternative is wrong:

- **Never keyed on `keyId`.** A trust store entry is an array of acceptable keys because rotation
  means two are valid at once; naming the key would make routine rotation move an app's data.
- **Origin, not path.** Anyone who can publish at `/evil/` can publish at `/app/`, so a path buys
  no isolation while breaking any app that moves.
- **`untrusted-key` treated as `unsigned`.** Key-scoping it would be storage trust-on-first-use,
  which Phase 9 lists as a non-goal.

An identity whose id disagrees with the manifest is **refused**, never downgraded to a weaker
namespace.

### Migration

The intent record is written **before** the first copied entry. That single ordering decision is
what distinguishes a half-copied namespace from one that simply has data in it:

| Record | Target | Means | Action |
|---|---|---|---|
| absent | empty | fresh | migrate |
| absent | non-empty | the app wrote here itself | **never adopt** |
| `pending` | any | interrupted | resume |
| `complete` | any | done | use it |

Copies and never deletes, so a rollback to a pre-Phase-10 host still finds its data. At most one
source is adopted; a second present source is reported, never merged.

Origin-tier adoption is automatic. Bare-id adoption requires explicit per-id host opt-in, because
those bytes were writable by any package at any origin. **A signature attests the package, never
the data the package inherits** — the record carries `attested: false`, and the host surfaces it.

## Commit sequence

Base: `a52c955`.

| Commit | Item | Summary |
| --- | --- | --- |
| `bf2f2d4` | W1 | pure scope derivation, unused |
| `be57246` | W2 | additive `entries()` on the storage provider |
| `a7e351e` | W3 | crash-safe migration protocol, wired to nothing |
| `34bb918` | W4 | **the flip** — storage consults provenance |
| `7320e0b` | W4a | **corrective** — keep provenance-free storage at the bare id |
| `b0b6234` | W5 | host opt-in for legacy adoption |
| `00c2a6c` | W6 | surface the resolved scope to the operator |
| `6e25e8f` | W7/W8 | browser e2e with real provenance and real IndexedDB |

Machinery landed **before** the flip deliberately, so no commit in history has the shape "verified
apps' data stranded" — a commit `git bisect` could otherwise land on that is indistinguishable
from data loss.

### The corrective commit

W4 moved *every* tier to a versioned namespace, including `embedded` — the tier for a sandbox built
directly from a static fixture. That changed its key from the bare `manifest.id` to
`v1:embedded:<id>`, and since migration only ever runs for the verified tier, there was no
adoption path for it: an existing host's fixture data would have become unreachable, silently,
with no route back.

`7320e0b` is a forward fix, not a rewrite. The rule became: only packages that actually went
through a load move. No embedded migration was added — the repository offers no evidence the bare
scope is unsafe for that tier, since a URL-loaded package always carries provenance and so always
lands in a versioned namespace.

One W1 invariant had to be **restated rather than preserved**: the fuzz test asserted that no
derivation can reach the bare-id space, which is now false by design. It asserts instead that
`v1:meta:` stays unreachable, that the embedded tier *is* the bare id, and that every tier derived
from a real load is versioned and therefore distinct from it.

## Verification

| Gate | Result |
| --- | --- |
| lint, `format:check`, build, typecheck | pass |
| unit | **912 pass** (runtime 459, cli 147, manifest 142, shared 106, sdk 36, host 20, ui 2) |
| browser e2e | **35 pass** — 28 pre-existing unmodified, 7 new |

### Browser evidence

The 28 pre-existing e2e passing was evidence of no regression and nothing more: every
storage-touching one runs the `?scenario=` fixture path, which supplies no provenance and lands in
the embedded tier — the one tier this phase leaves alone. The Phase 9 signed fixtures carry no
script and cannot reach the bridge at all.

`e2e/storage-scope.spec.ts` closes that, driving `storage-probe` — a real `@openmini/sdk` Mini App
assembled by the CLI, served from `public/miniapps/`, therefore loaded **by URL with real
provenance** — and asserting against the browser's real IndexedDB directly:

| Property | Spec |
| --- | --- |
| verified-id scope | `a registered, signed package stores under v1:id:<id>` |
| origin-bound scope | `an unregistered, unsigned package stores under v1:origin:<origin>\|<id>` |
| cross-origin isolation | `the same id served from two origins gets two separate stores` |
| migration / adoption | `carries its origin-tier data forward`, `does not re-adopt on a later load`, `leaves bare legacy data alone` |
| real persistence | `verified-scope data survives a full page reload` |

Two bugs surfaced while writing these. The probe reported ready before making any storage call, so
the host had nothing to report. And the cross-origin 404 for a missing `openmini.sig.json` carried
no CORS header, so the browser blocked it — and because the loader deliberately treats a network
failure as "no answer" rather than "unsigned", the whole load failed. That second one is worth
recording: had the loader read an unreachable signature as "unsigned", the test would have passed
silently.

## Limitations carried into future phases

1. **Same-origin collisions remain.** Two *unsigned* packages served from the same origin that both
   claim one id still share a store. Pinned by `storageIdCollision.test.ts`.
2. **Concurrent multi-tab migration.** One tab completing and switching while another is mid-resume
   can lose a write made in the gap. Storage is already documented as best-effort under concurrent
   writes; this does not widen that, and the single-session case is safe.
3. **No key distribution, revocation, expiry or rotation protocol** (carried from Phase 9).
4. **The signing key file is unencrypted** (carried from Phase 9).
5. **`user.getProfile()` is still a stub.** Real user identity remains sequenced after package
   identity.
6. **Two stale docstrings** Phase 9 falsified: `packages/cli/src/commands/build.ts` and
   `packages/runtime/src/sandbox/fetchResourceProvider.ts` both still say "a later phase intends
   to…" about work Phase 9 shipped.
7. **`Object.prototype` own-property guard** in `packageVerification` and the digest lookup
   (Phase 9 audit observation; unreachable today and fails closed regardless).
8. **W11 / `.gitattributes`** remains optional and unimplemented, as does release/publishing,
   `SECURITY.md`, and a CI matrix.
