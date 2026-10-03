# Phase 12 — session-scoped user identity (completed)

**Status: complete.** Approved on 2026-10-03 against base `c443cfc`; delivered in eight work
items, W1-W8, and merged to `main` at `4241fd3` with
[CI green](https://github.com/Zhihaohu1996/openmini/actions/runs/37152399177).

This file is the approved plan. It is written *before* implementation deliberately, so that the
scope, ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. It is now the authoritative **phase record**, in the same form as [phase-9.md](phase-9.md),
[phase-10.md](phase-10.md) and [phase-11.md](phase-11.md). The plan text below is preserved as
it was approved — including the parts written in the future tense — and the outcome is recorded
in ["What actually shipped"](#what-actually-shipped) at the end, which is authoritative where
the two differ.

Living documentation for the delivered system will be
[security/bridge.md](../security/bridge.md). This file is the plan and then the history; it is
not updated as the code changes afterwards.

---

## Baseline

| | |
|---|---|
| Base commit | `c443cfc` — Phase 11 close-out, CI recorded |
| Working tree | clean |
| Unit tests | **1072 pass** (runtime 512, cli 179, shared 157, manifest 142, host 44, sdk 36, ui 2) |
| Browser e2e | **49 pass**, 20 spec files (Chromium) |
| CI | one workflow, `.github/workflows/ci.yml`: `build` job (lint → format:check → build → typecheck → test) and `e2e` job (Chromium) |

---

## Goal

Make `user.getProfile()` a real capability by making it **gated**, without making it
**persistent**.

`user.*` is the last decorative permission. [user.ts](../../packages/runtime/src/bridge/handlers/user.ts)
is nineteen lines returning a hardcoded `{ id: null, displayName: null }`, and Phase 11's own
record says the permission "currently means nothing". Every other namespace became real in some
phase: `storage` in Phase 5, `network` in Phase 7, `navigation.close` has had a real
ack-confirmed teardown since Phase 4. `user` never did.

Phase 11 deferred real user identity for three stated reasons
([phase-11.md](phase-11.md), "Why this, and not real user identity"). Exactly one has closed,
and the close-out says so explicitly — it is the only entry in that ledger annotated as having
had a precondition completed by the previous phase:

> "Phase 11 did complete one precondition for it: the verified tier is entered by registration,
> and registration is now something an operator can actually perform."

The other two reasons both block the **persisted** variant and only the persisted variant:

- Reason 2 — sign-out and account-switch need deletion or a per-user partition, and
  `MiniAppStorageProvider` deliberately has no `delete` and no `clear`.
- Reason 3 — "it is not one phase", spanning manifest semantics, the bridge protocol, the SDK,
  the host UI, a `v2:` per-user storage scope, and an identity-provider model.

**This phase ships the slice that needs neither.** The host supplies a profile at
bridge-creation time, its lifetime is the sandbox, and nothing is written anywhere. Sign-out is
`sandbox.destroy()`, which already exists and is already correct. Account switch is
destroy-and-recreate. The no-delete invariant is not respected so much as never approached, and
no `v2:` scope is needed because no storage is involved.

What makes this a capability rather than a nicer stub is the **gate**, not the value: an
unverified package never receives a user identity. That makes `ctx.provenance` read by its
second handler — Phase 9 threaded it, Phase 10 made storage consume it, and this phase repeats
the pattern for a second namespace.

## Why this, and not the alternatives

Two other objectives were considered in discovery and rejected for reasons out of the
repository rather than out of preference.

**Operator-owned capability ceilings** — letting the operator cap what a registered id may do,
since `computePermittedNamespaces` reads only the app-controlled manifest. Rejected on three
grounds:

1. **It fails this repository's own sequencing test.** Every phase since 8 has closed a gap its
   predecessor's record named as *carried*. Capability gating appears in no carried-forward
   ledger — not in [phase-11.md](phase-11.md)'s limitations, not in
   [integrity.md](../security/integrity.md)'s "What this is still not", not in the README. It
   appears once, as a Phase 10 **non-goal**, and Phase 11 did not resurrect it.
2. **It would contradict a Phase 9 decision.** [integrity.md](../security/integrity.md) requires
   `openmini.json` to be covered by the signature precisely because "a signature omitting it
   would attest to the code while leaving what the code is *allowed to do* unsigned." A ceiling
   makes that signed statement advisory.
3. **It institutionalises a cheaper path.** Phase 11 invariant 3 is that a failed check must
   never become a cheaper path. Offering an operator "cap it" as an alternative to "revoke it"
   is exactly that, and it is a choice an operator will make under deadline pressure.

Its one defensible instinct — that capability should depend on identity — is absorbed here, in
the form that needs no second policy file and cannot drift from the manifest: the gate is
**derived** from provenance rather than **configured**.

**A consolidation phase** (Phase 8.5 style) was rejected as a phase. Phase 8.5 was predominantly
five real security fixes with documentation as one tail commit; the equivalent list today is one
real bug and some prose. Phase 11 decision 4 declined that list for the third consecutive time.
The items that are genuinely entailed by this phase fold into it; the rest are recorded under
"Found in discovery, deliberately out of scope".

---

## What ships

### The gate

```
provenance.identity.verified === true   →  the host's profile
provenance.identity.verified === false  →  { id: null, displayName: null }
provenance === undefined                →  { id: null, displayName: null }
host supplied no profile                →  { id: null, displayName: null }
```

Two independent gates, both of which must pass for a package to learn anything:

1. **The app must ask.** `permissions` must include `user`, exactly as today. Unchanged.
2. **The package must be verified.** New.

The second gate is the phase. The first is Phase 4's and is not touched.

### The value

The host supplies the profile. There is no protocol for *obtaining* one — no login, no identity
provider, no token exchange. A host that has an authenticated session of its own passes what it
knows; a host that does not passes nothing, and every package sees nulls.

`createUserHandlers({ profile })` follows the option-bag shape already used by
`createStorageHandlers({ provider, … })` and `createNetworkHandlers({ allowInsecureLoopback })`,
and is wired in the same place in [MiniAppHost.tsx](../../apps/host/src/miniapp/MiniAppHost.tsx).

### Lifetime

The dispatcher's. Nothing is written to storage, so there is nothing to delete, and
`sandbox.destroy()` — which already tears the bridge down through the `close-ack` sequence — is
a complete sign-out.

---

## Invariants this phase must preserve

Each is a property an implementation could plausibly break, so each gets a test.

1. **An unverified package never receives a user identity.** Both `verified: false` and
   `provenance === undefined` yield nulls, whatever the host supplied.
2. **A package cannot distinguish "the host has no profile" from "the host withheld it."** Both
   are the same value, for the same reason the dispatcher collapses unknown-namespace and
   unpermitted-namespace into one `PERMISSION_DENIED`: a guest must not be able to probe the
   host's state.
3. **Nothing is persisted.** `MiniAppStorageProvider` is untouched — no `delete`, no `clear`, no
   `v2:` scope, no new provider method.
4. **The `user` permission still gates the namespace**, independently of provenance. A verified
   package that did not declare `user` is still denied.
5. **No load outcome changes.** `verifyPackage`, `PackageProvenance`, every refusal code and the
   storage derivation are untouched. No package that loads today stops loading.
6. **Phase 10 and Phase 11 behaviour is unchanged** — storage scoping, migration, rotation
   continuity, revocation and anti-downgrade. `storageIdCollision.test.ts` stays unmodified.

---

## Non-goals

Stated so they cannot drift in:

- Login flows, OAuth, SAML, or any identity provider.
- Tokens, credentials, or secrets of any kind crossing the bridge.
- Persistence of the profile across reloads.
- Cross-app or cross-origin identity.
- A per-user storage partition or any `v2:` storage scope.
- Sign-out semantics beyond destroying the sandbox.
- Any change to `MiniAppStorageProvider`.
- Operator-authored capability ceilings.
- Events or subscriptions on `user.*` — the bridge has no lifecycle model for them, which
  [bridge.md](../security/bridge.md) already records.

**The persistence pressure is foreseeable and is refused in advance.** The moment
`getProfile()` returns a real value, the natural next request is "let the app store it". That
needs deletion, and trading away the no-delete invariant under feature pressure is the single
worst outcome available here. A later phase may do it deliberately, with a design; this one will
not do it by drift.

---

## Security and backward-compatibility risks

| Risk | Detail | Mitigation |
|---|---|---|
| Gating on the wrong condition | Checking `provenance !== undefined` instead of `identity.verified` admits the origin tier — an unsigned package at a shared origin would learn the user's identity. | Invariant 1, with a test for each provenance shape and a mutation row. |
| A distinguishable withheld value | Returning a marker, throwing, or omitting a field would let a package probe whether the host has a session. | Invariant 2. |
| Persistence creeping in | A profile that is "cached" in storage would reopen Phase 10's invariant. | Invariant 3, and the non-goal above. |
| The two gates collapsing into one | Treating verification as implying permission, or vice versa. | Invariant 4: a verified package without the `user` permission is still denied. |
| Over-claiming in the docs | "User identity" suggests a login system. | The docs state the bound in the same sentence as the capability. |

---

## Work items and commit boundaries

Machinery lands before the flip, for the reason Phases 10 and 11 both recorded: no commit in
history should have the shape "a legitimate package stopped working", because a commit
`git bisect` lands on that is indistinguishable from a regression.

| # | Commit | Scope |
|---|---|---|
| W1 | `feat(shared)` | A shared `UserProfile` type. `StubUserProfile` (runtime) and `OpenMiniUserProfile` (SDK) are structurally duplicated today with no shared definition — the split the bridge protocol already avoids. **Wired to nothing; no behaviour change.** |
| W2 | `feat(runtime)` | `createUserHandlers({ profile })` accepts the host profile and reads `ctx.provenance`, but **still returns nulls unconditionally**. A test pins that provisional state so W3 announces itself by breaking it — the Phase 11 W2 technique. **No behaviour change.** |
| W3 | `feat(runtime)` | **The flip.** A verified package receives the profile; everything else receives nulls. Invariants 1, 2 and 4 land here. |
| W4 | `test(runtime)` | The gate matrix end to end on values: real keys → `verifyPackage` → dispatcher → handler, across every provenance shape and both gates. **No production code.** |
| W5 | `feat(host)` | The host supplies a demo profile and reports what it handed over, or that it withheld one and why. Fixture generator gains a verified package that reads the profile. |
| W6 | `fix(cli)` | The `init` scaffold defect — see below. |
| W7 | `test(e2e)` | Browser evidence, URL-loaded with real provenance and a real dispatcher. **No production code.** |
| W8 | `docs` | `bridge.md`, `integrity.md`, both READMEs; narrow the limitation rather than deleting it; repair the carried-forward entries Phase 11 dropped; retract the provenance docstrings this phase falsifies. |

### W6 — the `init` scaffold defect

Found in discovery and genuinely entailed by this phase, because the bug *is* the `user`
permission meaning nothing.

[init.ts](../../packages/cli/src/commands/init.ts) scaffolds `permissions: []`, and the entry
script it writes calls `await openmini.user.getProfile()` **outside** the `try` that wraps
`connectOpenMini()`. The dispatcher answers `PERMISSION_DENIED`, `main()` has no further catch,
and `void main()` makes it an unhandled rejection — so every freshly scaffolded app fails on
first run with its status line stuck at `starting...`.

Nothing catches it: `init.test.ts` asserts on the generated source as *strings*,
`cli.binary.test.ts` never invokes `init` at all, and the CLI e2e uses `hello-styled`, a fixture
that deliberately only completes the handshake. **No test in this repository has ever executed
`init` output.**

**The fix is to remove the call and keep `permissions: []`.** Adding `'user'` to the scaffold
would make the default scaffold request the identity permission — and a security boundary whose
default is "on" is not a boundary, which is doubly wrong in the phase that makes the permission
mean something. Merely catching the rejection would ship a scaffold that prints "permission
denied" on first run and teaches the author that the tool is broken. The real defect is that
`init` emits a manifest and an entry script that **disagree about what the app may do**.

The test is an invariant rather than a string match: parse the scaffolded manifest's
`permissions`, scan the scaffolded entry script for `openmini.<ns>.` call sites, and assert every
namespace called is declared.

### W8 — ledger repair

Phase 11's W8 was instructed to *narrow* carried-forward limitations rather than delete them.
Two fell off and are restored here:

- **Multi-view routing**, which was in the pre-Phase-11 README's "Still to come" and survives
  only as a Phase 11 *non-goal* — a heading meaning "not this phase", not "still outstanding".
- **The `Object.prototype` own-property guard**, carried in the Phase 9 and Phase 10 records and
  absent from Phase 11's. It was *partly* closed as a side effect — `Object.create(null)` in
  `trustStoreFromConfig` and the trust-config parser — and nobody recorded that.

---

## Test plan

### Fail-before / pass-after, unit

Each must fail against `c443cfc` and pass at close-out.

1. A verified package with the `user` permission receives the host's profile.
2. An unverified package (`verified: false`, origin tier) receives nulls.
3. A provenance-free sandbox (embedded tier) receives nulls.
4. A verified package receives nulls when the host supplied no profile.
5. The withheld value is byte-identical to the no-profile value (invariant 2).
6. A verified package **without** the `user` permission is denied at the dispatcher, not handed
   nulls (invariant 4 — the gates are independent).
7. Rotation: the profile a verified package receives does not depend on which registered key
   signed it. Same claim Phase 11 made for the storage namespace.
8. A revoked package never reaches the handler, because it never loads.
9. **Regression:** `packageVerification.test.ts`, `storage.test.ts`, `dispatcher.test.ts` and
   `storageIdCollision.test.ts` pass unmodified.

### Browser e2e

URL-loaded with real provenance, never `?scenario=` — the Phase 10 lesson, which Phase 11
restated: a fixture path supplies no provenance and therefore proves nothing about this layer.

1. A verified, registered package renders the identity the host supplied.
2. An unverified package renders anonymous, and the host reports that it withheld one.
3. A verified package that did not declare `user` is denied.
4. All 49 existing e2e specs pass unmodified.

---

## Exit criteria

- `pnpm lint`, `pnpm build`, `pnpm typecheck` pass. `pnpm format:check` continues to fail
  locally on the pre-existing Windows CRLF checkout artifact only — confirmed by comparing
  `git hash-object <file>` with `git rev-parse HEAD:<file>` — and is left alone, as in Phases
  9–11.
- Unit tests **at least 1072**, all passing. No pre-existing test modified except where W2, W3
  or W6 require it, and any such modification called out in its commit message with the reason.
- Browser e2e **at least 49**, all passing, including the new specs.
- `storageIdCollision.test.ts` unmodified and passing.
- Every invariant above has at least one test naming it.
- Pushed to `main`, CI green on the exact pushed HEAD, and the run recorded in this file.

---

## Found in discovery, deliberately out of scope

Recorded here so they are not lost, and so the next planner does not have to rediscover them.
None is entailed by user identity, and folding them in would be the scope drift this plan's
non-goals exist to prevent.

- **A real defect in signed-payload parsing.** `__proto__` passes `validateFilePath` in
  [integrity.ts](../../packages/shared/src/integrity.ts), and the files map is built as a plain
  `{}`, so such an entry is **silently dropped** from a signature payload. Verified concretely.
  Fail-closed in effect, but it is security-critical parsing discarding a signed statement
  without saying so. Deserves its own `fix(shared)` commit.
- **`SandboxOptions.provenance` is dead API.** `createSandbox.ts` contains zero references to it;
  the copy that is actually read is `BridgeDispatcherOptions.provenance`. A host setting it
  reasonably believes it has told the sandbox something. Its docstring still says "Nothing reads
  this yet; it is carried so the verification work does not have to re-thread it" — and the
  verification work re-threaded it through a different option bag anyway.
- **Two further prototype-indexed lookups**, at `packageVerification.ts`'s
  `trustStore?.[manifestId]` and `fetchResourceProvider.ts`'s `this.digests?.[signedPath]`. Both
  are unreachable through `loadMiniAppFromUrl` — `ID_PATTERN` requires a dot — but both are
  reachable through the exported API.
- **The repository's only conditional test**, `build.test.ts`'s `it.runIf(unusedDriveLetter)`
  case, runs only on Windows and has therefore **never executed in CI**. It guards the `--out`
  containment whose regression once deleted `packages/` for real. A CI matrix is the fix; this
  is a verification gap rather than tidiness.
- `SECURITY.md`, a CI matrix, and the `.gitattributes` / CRLF item declined three phases running.

---

# What actually shipped

Everything below this line was written at close-out and is authoritative where it differs from
the plan above.

## Commit sequence

Base: `c443cfc` — Phase 11 close-out, CI recorded.

| Commit | Item | Type | What it delivered |
| --- | --- | --- | --- |
| `44456d1` | — | `docs` | The approved plan above, recorded before implementation. |
| `5c25bb8` | W1 | `feat(shared)` | `UserProfile` and `ANONYMOUS_USER_PROFILE` in [bridge/user.ts](../../packages/shared/src/bridge/user.ts). The shape existed twice before — `StubUserProfile` in the runtime, `OpenMiniUserProfile` in the SDK — structurally identical and related by nothing; both survive as deprecated aliases. The anonymous value is one frozen constant, so the three reasons for withholding cannot drift apart. **Wired to nothing.** |
| `511e1df` | W2 | `feat(runtime)` | `createUserHandlers({ profile })` takes the host profile; the decision moves into the pure `resolveUserProfile(provenance, hostProfile)`, which reads neither yet. The handler reaches its **final** shape here, so W3 changes a function body and no signature. **No behaviour change**, pinned by four tests that W3 breaks. |
| `6cf020a` | W3 | `feat(runtime)` | **The flip.** One production file, one function body. A verified package receives the profile; everything else receives the anonymous constant. |
| `2fc88af` | W4 | `test(runtime)` | The gate over the real chain — real P-256 keys → real signature → `verifyPackage` → the real dispatcher over a real `MessageChannel` → the handler. No provenance written by hand. **No production code.** |
| `d7f1b07` | W5 | `feat(host)` | The host supplies a synthetic demo profile and reports what it shared or withheld. Three fixtures (`user-signed`, `user-unsigned`, `user-unpermitted`) built from one Mini App source. |
| `9c81492` | W6 | `fix(cli)` | The `init` scaffold defect: the generated manifest and entry script disagreed about what the app may do. |
| `c794e6e` | W7 | `test(e2e)` | Browser evidence through the host's real "Load by URL" flow. **No production code.** |
| *this commit* | W8 | `docs` | Living documentation narrowed, ledger repaired, this file converted into the phase record. |

Machinery landed before the flip, as in Phases 10 and 11: no commit in history has the shape "a
legitimate package stopped working".

## The security boundary, precisely

| Situation | Result |
| --- | --- |
| Verified **and** declares `user` | the host-supplied profile |
| Verified, does **not** declare `user` | `PERMISSION_DENIED` — a refusal, not an anonymous profile |
| Unverified (`unsigned` or `untrusted-key`), declares `user` | a **successful** call returning the anonymous profile |
| No provenance at all (fixture, test) | the anonymous profile |
| Verified, but the host supplied no profile | the anonymous profile |
| Signing key revoked for the id | never reaches the handler — the load is refused and no provenance exists |

Two independent gates, neither substituting for the other: the manifest's `user` permission,
enforced by the dispatcher before any handler runs, and `identity.verified`, enforced inside
`resolveUserProfile`.

The condition is `identity.verified`, deliberately **not** `provenance !== undefined`. Those
differ precisely where it matters: an unsigned or untrusted-key package *has* provenance and is
not verified, so a presence check would admit the whole origin tier while still passing every
fixture-shaped test.

**No identity is persisted.** The profile lives for the lifetime of the dispatcher and is written
nowhere. `sandbox.destroy()` therefore ends its lifetime completely — sign-out needs no deletion
because nothing was stored.

## What Phase 12 did not introduce

Verified against the diff rather than asserted: no persistence of any kind, no login flow, no
OAuth, no tokens, no credentials, no identity provider, no per-user storage, no `v2:` scope, and
**no change to any load outcome**.

`git diff c443cfc..HEAD` touches these production files and no others:
`shared/src/bridge/user.ts`, `shared/src/index.ts`, `runtime/src/bridge/handlers/user.ts`,
`sdk/src/api/user.ts`, `apps/host/src/App.tsx`, `apps/host/src/miniapp/MiniAppHost.tsx`,
`apps/host/scripts/build-signed-fixtures.ts`, the new `user-probe` fixture source, and
`cli/src/commands/init.ts`.

Untouched, confirmed by an empty diff: `packageVerification.ts`, `loadMiniAppFromUrl.ts`, the
whole of `sandbox/`, `storage.ts`, `storageScope.ts`, `storageMigration.ts`, `storageProvider.ts`
(still four methods, still no `delete` and no `clear`), `trustConfig.ts`, and
`packages/manifest/**`.

### The host's demo profile is synthetic

`DEMO_USER_PROFILE` in [App.tsx](../../apps/host/src/App.tsx) is a fixed constant —
`{ id: 'demo-user', displayName: 'Demo User (synthetic, not a real account)' }`. **The demo host
authenticates nobody.** There is no sign-in, no account and no session behind it. It exists so
the gate can be seen working, and it names itself in its own display name so that nothing
reaching a Mini App or a screenshot can be mistaken for a login. A real host would pass whatever
its own session already knows; establishing that is outside this runtime.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | **1119 pass** (runtime 538, cli 184, shared 160, manifest 142, host 57, sdk 36, ui 2) |
| `pnpm e2e` | **59 pass**, Chromium — 49 pre-existing **unmodified**, 10 new |
| `pnpm format:check` | fails locally on the pre-existing CRLF artifact only — see below |

Progression: 1072 → 1075 (W1) → 1082 (W2) → 1091 (W3) → 1101 (W4) → 1114 (W5) → 1119 (W6) →
1119 (W7, which added browser specs only). Browser e2e 49 → 59 at W7.

### Pre-existing tests modified, and why

Three, each called out in its own commit message:

- **`user.test.ts`** (W2) — import line only; the Phase 4 stub test is unchanged in body and
  still passes.
- **`user.test.ts`** (W3) — one block removed, `the withheld value`'s first case. It was W2's pin
  asserting a verified package still receives nulls; it existed to be broken by W3 and was. Its
  successor is the identity assertion in the indistinguishability block.
- **`dispatcher.test.ts`** (W3) — one import line and a new describe block; no existing case
  touched.

### Fail-before / pass-after

Every behavioural claim was checked by mutation, the production code reverted each time and the
tree confirmed clean before committing.

| Mutation | Effect |
| --- | --- |
| Gate on `provenance !== undefined` instead of `identity.verified` | 3 unit tests fail (W3), 4 more over the real chain (W4) |
| No gate at all — the profile to everyone | 6 unit tests (W3), 3 browser specs (W7) |
| Withheld value rebuilt instead of the shared constant | 1 (W3) |
| Absent host profile returned as-is | 3 (W3) |
| Entitlement derived from the `keyId` | 4 (W4) |
| **`verifyPackage` never reports a verified identity** | **2 (W4), and 0 of W3's 13** |
| **Host stops passing its profile to `createUserHandlers`** | **2 browser specs (W7), and 0 of 1119 unit tests** |
| `init` template reverted to call `getProfile()` | 3 (W6) |
| `describeUserIdentity` ignores the permission gate | 2 (W5) |

The two bold rows measure gaps that would otherwise be invisible. W4 exists because W3's tests
build provenance by hand and would all pass if the verifier stopped producing the shape the gate
reads. W7 exists because jsdom never executes a sandbox's `srcdoc`, so no unit test can observe
whether the host actually wires its profile through — a gap W5 recorded against itself and W7
closed.

### Browser evidence (W7)

[`e2e/user-identity.spec.ts`](../../e2e/user-identity.spec.ts), ten cases, every one driven
through the host's own "Load by URL" control against packages served from `public/miniapps/`
with provenance the verifier produced. Never `?scenario=`, which supplies no provenance and would
land in the embedded tier — where the answer is anonymous for a reason unrelated to the gate.

| Property | Cases |
| --- | --- |
| Verified package is told | renders `demo-user` in its own DOM; host reports `shared`; fixture asserted verified |
| Unverified package is not | renders `anonymous`, and negatively asserts neither field carries any part of the host profile; still loads and runs; host reports `withheld` and why |
| The gates are independent | `PERMISSION_DENIED` reaches the frame as a rejection, identity elements still `pending`; pinned against the withheld case so the two cannot be collapsed |
| Nothing persists | after a verified package has seen the identity, an unverified package in the same browser still learns nothing |

### CI

Pushed to `main` as `c443cfc..4241fd3`.

| | |
| --- | --- |
| Head SHA | `4241fd336c079665e47627b7eb524d3fe05b9f1b` (W8) |
| Run | [CI #18](https://github.com/Zhihaohu1996/openmini/actions/runs/37152399177), event `push` |
| `build` job | **success** — lint → format:check → build → typecheck → test |
| `e2e` job | **success** — Chromium, 59 specs |
| Result | **green** |

Both jobs ran against that exact SHA, not a later one.

The `build` job runs `pnpm format:check`, and it **passed on CI** while failing on the Windows
working tree — the CRLF diagnosis below confirmed from the other side for the second phase
running.

### The CRLF artifact, preserved

`pnpm format:check` fails on this Windows checkout and did so before Phase 12 began. It is a
working-tree artifact, not content: `core.autocrlf=true` checks files out with CRLF, Prettier
reads them from the worktree and objects, while the committed blobs are LF and identical to what
CI checks out on Linux. The two files it names —
`apps/host/src/miniapp/fixtures/hello-styled/src/index.html` and
`packages/runtime/src/bridge/handlers/storageScope.ts` — are not touched by this phase.

The diagnostic, rather than reformatting: compare `git hash-object <file>` against
`git rev-parse HEAD:<file>`. They matched throughout. `.gitattributes` remains the real fix and
remains declined — a fourth phase running.

## Limitations carried into Phase 13

1. **No authentication of a person.** *Narrowed, not closed.* `user.getProfile()` relays a
   profile the host already has. There is no sign-in, credential, token, session, account or
   identity provider, and no protocol by which this runtime could establish identity rather than
   relay it. Signing a package authenticates the publisher, never the user.
2. **No persistence of user identity, and no per-user storage.** Deliberate, and the reason this
   phase fit: persisting it would need deletion for sign-out, and `MiniAppStorageProvider` still
   has no `delete` and no `clear`. No `v2:` scope exists.
3. **No remote trust distribution or registry** — no CRL, no OCSP, no transparency log, no PKI
   (carried from Phase 11, unchanged).
4. **No expiry or timestamp semantics**, because without a trusted timestamp authority an expiry
   would depend on the host's clock and could not establish signing time (carried from Phase 11,
   unchanged).
5. **No trust on first use** — fifth phase running.
6. **Same-origin collisions for unregistered packages**, intentionally distinct from verified
   identity. `storageIdCollision.test.ts` unmodified.
7. **Signing-key custody is an unencrypted local file** at `0600` (carried from Phase 9).
8. **Concurrent multi-tab migration** (carried from Phase 10).
9. **Multi-view routing.** *Restored to the ledger here.* It was in the pre-Phase-11 README's
   "Still to come" and the Phase 11 rewrite dropped it against that work item's own instruction
   to narrow rather than delete; it survived only as a Phase 11 *non-goal*, a heading meaning
   "not this phase" rather than "still outstanding". `navigation.close()` remains the whole of
   the navigation surface: no routing, no views, no back/forward, and no manifest vocabulary for
   more than one `entry`.
10. **The `Object.prototype` own-property guard.** *Restored to the ledger here, with its
    partial closure recorded accurately.* It was carried in the Phase 9 and Phase 10 records and
    absent from Phase 11's, having been **partly** closed as a side effect that nobody wrote
    down. Current evidence:
    - **Closed** for the two config-derived producers: `trustStoreFromConfig`
      (`packageVerification.ts:77`) and the trust-config parser (`trustConfig.ts:365`) both build
      their maps with `Object.create(null)`.
    - **Still open**, three bare indexed lookups over plain objects:
      `trustStore?.[manifestId]` (`packageVerification.ts:192`), `this.digests?.[signedPath]`
      (`fetchResourceProvider.ts:141`), and the signed-payload files map built as `{}`
      (`integrity.ts:277`, written at `:303`).

    Unreachable through `loadMiniAppFromUrl` for the first, since `ID_PATTERN` requires a dot —
    but all three are reachable through the exported API. **Not fully resolved.**
11. **No release or publishing workflow**, no `SECURITY.md`, no CI matrix.
12. **`.gitattributes` / CRLF normalization** remains optional and unimplemented.

## Found in discovery, deliberately out of scope and still open

Carried forward from the plan above, re-verified at close-out and **not fixed by this phase**:

- **A real defect in signed-payload parsing.** `__proto__` passes `validateFilePath` in
  [integrity.ts](../../packages/shared/src/integrity.ts), and the files map is a plain `{}`, so
  such an entry is **silently dropped** from a signature payload — confirmed by running it.
  Fail-closed in effect, but security-critical parsing discarding a signed statement without
  saying so. Deserves its own `fix(shared)` commit. This is item 10's third site.
- **`SandboxOptions.provenance` is dead API.** `createSandbox.ts` contains zero references to it;
  the copy that is read is `BridgeDispatcherOptions.provenance`. A host setting it reasonably
  believes it has told the sandbox something, and its docstring still claims the field exists so
  the verification work would not have to re-thread provenance — which it then did, elsewhere.
- **The repository's only conditional test**, `build.test.ts`'s `it.runIf(unusedDriveLetter)`
  case, runs only on Windows and has therefore never executed in CI. It guards the `--out`
  containment whose regression once deleted `packages/` for real. A CI matrix is the fix; this is
  a verification gap rather than tidiness.
