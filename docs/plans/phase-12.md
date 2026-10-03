# Phase 12 — session-scoped user identity

**Status: approved, implementation not started.** Approved on 2026-10-03 against base `c443cfc`.

This file is the approved plan. It is written *before* implementation deliberately, so that the
scope, ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. At close-out it becomes the phase record, in the same
form as [phase-9.md](phase-9.md), [phase-10.md](phase-10.md) and [phase-11.md](phase-11.md).

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
