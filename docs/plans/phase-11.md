# Phase 11 — trust lifecycle: operator-owned trust configuration, revocation and rotation (completed)

**Status: complete.** Approved on 2026-09-23 against base `1604212`; delivered in eight work
items, W1–W8, and merged to `main` at `df58b54` with
[CI green](https://github.com/Zhihaohu1996/openmini/actions/runs/37141422322).

This file was written as the approved plan *before* implementation, so that the scope, ordering,
invariants and exit criteria would survive across sessions rather than being reconstructed from
conversation memory. It is now the authoritative **phase record**, in the same form as
[phase-9.md](phase-9.md) and [phase-10.md](phase-10.md). The plan text below is preserved as it
was approved — including the parts that describe intent in the future tense — and the outcome is
recorded in ["What actually shipped"](#what-actually-shipped) at the end. Where the two differ,
the close-out sections are authoritative.

Living documentation for the delivered system is
[security/integrity.md](../security/integrity.md), [cli.md](../cli.md) and
[security/bridge.md](../security/bridge.md). This file is the plan and then the history; it is
not updated as the code changes afterwards.

---

## Baseline

| | |
|---|---|
| Base commit | `1604212` — Phase 10 W9 close-out |
| Working tree | clean |
| Unit tests | **912 pass** (runtime 459, cli 147, manifest 142, shared 106, sdk 36, host 20, ui 2) |
| Browser e2e | **35 pass**, 19 spec files (Chromium) |
| CI | one workflow, `.github/workflows/ci.yml`: `build` job (lint → format:check → build → typecheck → test) and `e2e` job (Chromium) |

---

## Goal

Make the host's trust decision **operator-owned data with a lifecycle**, instead of a hardcoded
map with no way to retire a key.

Phase 9 built load-time verification against a trust store and Phase 10 made the resulting
identity decide the storage namespace. Both phases listed the same thing first in their
non-goals, and both living security documents still close with it:

> "There is no registry, no expiry, no revocation list, and no rotation protocol. A host operator
> configures trusted keys by hand, and removes a compromised one the same way."
> — [security/integrity.md](../security/integrity.md)

Two concrete gaps follow from that, and Phase 11 closes both:

1. **The trust store is not configuration — it is a generated test fixture.** The production host
   imports `FIXTURE_TRUST_STORE` from `apps/host/src/miniapp/fixtures/generated/trustConfig.ts`
   ([App.tsx](../../apps/host/src/App.tsx), lines 21 and 147), a **gitignored** module written by
   `scripts/build-signed-fixtures.ts`. `apps/host/package.json` runs `build:fixtures` before
   `build`, so the host cannot build without the fixture generator. A self-hoster cannot register
   an id without editing source — which is in direct tension with the README's "self-hosted first"
   principle.

2. **A key can be added but never retired.** The trust entry is an array *because* rotation means
   two keys are valid at once — that reasoning is already written down in
   [storageScope.ts](../../packages/runtime/src/bridge/handlers/storageScope.ts) as the reason the
   verified namespace names the id and never the `keyId`. But the only way to stop trusting a key
   is to delete it from the array, which erases the record that it was ever trusted, and produces
   the same refusal as a key that was never registered at all — two situations with different
   operator remedies.

## Why this, and not real user identity

Real user/auth identity is the obvious Phase 11: `user.getProfile()` is the loudest remaining
stub, and [bridge.md](../security/bridge.md) says real user identity "is sequenced *after*
package identity rather than before it". Package identity shipped in Phase 10, so it looks next.

It was considered and **deliberately sequenced behind this phase**, for three reasons that come
out of the repository rather than out of preference:

1. **The sentence that sequences it also states its precondition, and the precondition is only
   half-met.** The full passage reads: storage under an unregistered id on a shared origin is not
   private, "so do not put anything there whose disclosure to another package on that origin would
   matter — **notably auth tokens**. That is one reason real user identity is sequenced *after*
   package identity." Credentials are therefore safe only in the **verified** tier, which is
   entered only by registration — and registration is currently unconfigurable (gap 1 above).
   Shipping credentials first would put them in a tier no operator can actually reach.

2. **It would immediately reopen a Phase 10 non-goal.** Sign-out and account-switch need either
   deletion or a per-user partition, and `MiniAppStorageProvider` deliberately has no `delete` and
   no `clear` — [storageProvider.ts](../../packages/runtime/src/bridge/handlers/storageProvider.ts)
   says that absence *is* the enforcement. A phase whose first act is to undo the previous phase's
   stated invariant is not the next step.

3. **It is not one phase.** It spans manifest semantics (the `user` permission currently means
   nothing), the bridge protocol, the SDK, the host UI, a `v2:` per-user storage scope — which
   [storageScope.ts](../../packages/runtime/src/bridge/handlers/storageScope.ts) already names as
   the anticipated next derivation — and an identity-provider model constrained by the README's
   "no required paid third-party APIs" and "platform neutral".

Revocation also bounds the blast radius of the failure that matters most once credentials exist:
a compromised signing key for a registered id reaches that id's verified-tier storage. Today the
only remedy is a source edit and a redeploy.

## Approved decisions

These four decisions were made at approval time and override the discovery report where they
differ:

1. **Objective is C1, trust lifecycle.** Real user/auth identity remains sequenced behind it and
   is explicitly out of scope.
2. **The trust-config format lives in `@openmini/shared`**, in a dedicated module (for example
   `packages/shared/src/trustConfig.ts`), holding the schema, types, parser and validator shared
   by the runtime and the CLI. It must **not** live in `@openmini/manifest`. Existing validation
   helpers may be reused, but the trust boundary is preserved in the module layout itself: the
   Mini App manifest is **app-controlled**, the trust configuration is **host/operator-controlled**,
   and the two must not share a package that invites them to share a schema.
3. **No `notAfter`, no signature expiry, no timestamp semantics.** Phase 11 implements an explicit
   `active` / `revoked` key lifecycle and rotation continuity, with **no host-clock dependence** of
   any kind. Expiry and timestamping are recorded as deferred work below.
4. **No hygiene work.** No `.gitattributes`, no CRLF normalization, no stale-docstring cleanup, no
   release/publishing work, no unrelated tidying. The phase stays single-purpose.

---

## What ships

### The format: `openmini.trust.json`

A host-operator-owned document, parsed and validated by a dedicated module in `@openmini/shared`.
Shape (exact field names to be settled in W1; the semantics below are the approved part):

```json
{
  "trustConfigVersion": 1,
  "packages": {
    "com.example.app": {
      "keys": [
        { "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...", "status": "active" },
        { "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE...", "status": "revoked" }
      ]
    }
  }
}
```

Rules carried over from the Phase 9 format work, because the reasoning has not changed:

- **Unknown fields are rejected**, not best-effort parsed — matching `openmini.sig.json`'s
  handling in [integrity.ts](../../packages/shared/src/integrity.ts).
- **An unrecognized `trustConfigVersion` is refused**, not downgraded.
- **`publicKey` is the complete base64 SPKI key material.** A `keyId` may appear as an operator
  convenience label but **must never decide trust** — see the invariants below.

### Type widening, with legacy entries preserved

`PackageTrustStore` is exported from `@openmini/runtime`
([index.ts](../../packages/runtime/src/index.ts)) and is today
`Readonly<Record<string, readonly string[]>>`. It widens to accept keyed entries **per element**:

```ts
export type TrustedKeyStatus = 'active' | 'revoked';
export interface TrustedKeyEntry {
  readonly publicKey: string; // complete base64 SPKI
  readonly status: TrustedKeyStatus;
}
export type PackageTrustStore = Readonly<Record<string, readonly (string | TrustedKeyEntry)[]>>;
```

A bare string normalizes to `{ publicKey, status: 'active' }`. This is additive: every existing
caller keeps working with no edit, and `packageVerification`'s existing tests are expected to
pass unmodified through W2.

### Revocation semantics

- A signing key registered for an id with `status: 'revoked'` **refuses the load**.
- **Registration is the presence of the id, not the presence of an active key.** An id whose keys
  are *all* revoked is still registered, so an unsigned package claiming it still fails closed.
  Revoking every key must never be a route back to the unregistered, permissive path.
- Revocation is **per id**. A key revoked for `com.example.a` and active for `com.example.b` is
  trusted for `b` and refused for `a`.
- A key that is **absent** from the entry produces the existing `untrusted-key` refusal, which is
  a different situation with a different remedy and must stay distinguishable.

### Refusal reasons become machine-readable

`verifyPackage` currently returns `{ ok: false; reason: string }`, and the existing tests assert
on the prose with `toMatch` regexes
([packageVerification.test.ts](../../packages/runtime/src/sandbox/packageVerification.test.ts)).
Phase 11 adds an **additive discriminant** on the failure branch — a `code` field — populated for
every existing refusal path as well as the new one. The prose in `reason` **must not change**, so
the existing assertions keep passing.

This exists because the host has to render "revoked" differently from "not registered" and from
"untrusted key": the remedies differ, and matching on prose to tell them apart is fragile. It is
the same reasoning `openmini verify` already applies when it "reports the two possible failures
separately, because the remedies differ" ([cli.md](../cli.md)).

### Rotation continuity

Rotation is: add the new key as `active`, mark the old one `revoked`. The package re-signed with
the new key must keep reading the data it wrote under the old one — because the verified namespace
is `v1:id:<id>` and names the id, never the `keyId`. Phase 11 does not change that derivation; it
proves the property holds, in a unit test and in a real browser against real IndexedDB.

### Host configuration loading, and what happens when it fails

The host reads a real `openmini.trust.json` at startup instead of importing a generated TypeScript
module. The fixture generator emits that JSON (still gitignored, still signed by an ephemeral
per-run key) so the fixtures become **one instance of the format** rather than the only trust
configuration that exists.

**If the trust configuration is missing or invalid, the host refuses to load any package by URL
at all, and says why.** This is the one place where "fail closed" needs stating carefully:
treating a broken config as an *empty* trust store would mean no id is registered, so nothing
fails closed and an impostor of a registered id would load as merely unverified. That is
fail-*open* wearing the word "empty". Refusing the load path outright is the fail-closed answer.

### CLI

`openmini trust validate [path]` — runs the same validator the host runs, through the shared
module, and reports issues through the shared formatter so the CLI and the host print identical
text. Tested through the built binary, per the Phase 9 W5 precedent.

---

## Invariants this phase must preserve

Each of these is a property an implementation could plausibly break, so each gets a test.

1. **Legacy `readonly string[]` trust entries keep working, unchanged, for the whole of Phase 11.**
   A bare string means an active key. The *transition point* — deprecation, then removal — is
   explicitly **not set by this phase**. It belongs to whichever later phase first has a reason to
   force it. Until then the legacy form is supported, not merely tolerated, and a regression test
   pins it.
2. **Registered identities fail closed.** Unsigned, or signed by a key the host has not registered,
   and a registered id does not load. Unchanged from Phase 9, including for an id whose every key
   is revoked.
3. **A revoked identity is refused, never downgraded to unverified.** It must produce `ok: false`.
   It must **not** produce `verified: false` / `untrusted-key`, and must therefore never reach the
   origin storage tier. This is Phase 9's step-1 anti-downgrade shape: a failed check must never
   become a cheaper path.
4. **Key rotation does not change the verified storage namespace.** `v1:id:<id>` is derived from
   the id and never from the `keyId`, and stays that way.
5. **No storage or IndexedDB redesign.** `storageScope.ts`, `storage.ts` and the provider
   interface are not modified. No `delete`, no `clear`, no GC, no TTL. A revoked id's data is not
   erased — it becomes unreachable because the load is refused, which is the Phase 10 position
   held rather than revisited.
6. **No real-user/auth work.** `user.getProfile()` stays a stub.
7. **No same-origin collision fix.**
   [storageIdCollision.test.ts](../../packages/runtime/src/bridge/storageIdCollision.test.ts) keeps
   asserting the leak, unmodified.
8. **No network trust registry and no PKI.** The trust configuration is a local file the operator
   owns. No fetching it over the network, no CRL, no OCSP, no transparency log, no discovery.
9. **No expiry or timestamp semantics**, and no host-clock dependence anywhere in the load
   decision.
10. **No W11 `.gitattributes`**, and no CRLF normalization.
11. **Trust is decided on complete SPKI key material, never on `keyId`.** A config entry whose
    `keyId` label matches but whose `publicKey` does not must not be trusted.

---

## Non-goals

- Real user/auth identity, and any `v2:` per-user storage scope.
- Trust on first use, in any form. Third phase in a row.
- Any network-fetched trust configuration, registry, CRL, OCSP, transparency log, or key
  discovery protocol.
- Signature expiry, `expires`, countersigning, or timestamping.
- Closing the same-origin collision for unsigned packages.
- Any destructive storage operation, or any change to the storage provider interface.
- Encrypting the signing key file — still needs a KDF, a passphrase prompt, and an answer for
  non-interactive CI.
- The multi-tab migration race carried from Phase 10.
- Multi-view routing.
- `.gitattributes` / CRLF normalization, stale-docstring cleanup, `SECURITY.md`, release and
  publishing, CI matrix — all explicitly excluded to keep the phase single-purpose.

## Deferred work, recorded here so it is not lost

- **Signature expiry and timestamping.** Excluded by decision 3, and worth stating *why* rather
  than only *that*: key validity windows would make the load outcome depend on the host's clock,
  and signature expiry additionally needs a payload-format bump — `expires` is currently rejected
  as an unknown field — plus a timestamping authority to mean anything. Without one, an attacker
  simply keeps serving the package that was signed before the deadline.
- **A transition point for legacy `string[]` entries** (invariant 1).
- Everything in the non-goals list above that is a capability rather than a decision.

---

## Security and backward-compatibility risks

| Risk | Detail | Mitigation |
|---|---|---|
| Downgrade via revocation | A revoked key demoting to `untrusted-key` would drop the package from the verified namespace to the origin namespace — silently losing its data *and* handing an attacker a cheaper path than a valid signature. | Invariant 3, with a fail-before test asserting both the refusal and that the storage tier is never derived. |
| "Empty store" mistaken for fail-closed | A config that fails to parse yielding an empty trust store registers nothing, so nothing fails closed. | Host refuses the URL load path outright and reports why. Explicitly tested. |
| All-keys-revoked reopens the permissive path | If registration were read as "has at least one active key", revoking everything would un-register the id. | Registration is presence of the id. Explicitly tested. |
| Data stranded by revocation | The verified namespace becomes unreachable while the id is revoked. | Intended, and documented rather than fixed by adding deletion. Re-registering restores access. Migration must not treat a revoked id as an adoption source. |
| Breaking the public API | `PackageTrustStore` is exported and consumed by the host and the fixture generator. | Per-element union; bare strings keep working; existing tests pass unmodified through W2. |
| Trust config parsing is new attack surface | A hostile or malformed config must fail closed. | Unknown-field rejection, version refusal, and the host-level refusal above. |
| `keyId` creeping into the trust decision | A per-key record makes matching on a label look natural. | Invariant 11, with a test where the label matches and the key does not. |

---

## Files and modules likely affected

**New**

- `packages/shared/src/trustConfig.ts` — schema, types, parser, validator.
- `packages/shared/src/trustConfig.test.ts`.
- A `trust` command under `packages/cli/src/commands/`.
- `e2e/trust-lifecycle.spec.ts`.

**Modified**

- [packages/runtime/src/sandbox/packageVerification.ts](../../packages/runtime/src/sandbox/packageVerification.ts) — the trust store type, steps 4/5, refusal codes.
- [packages/runtime/src/sandbox/loadMiniAppFromUrl.ts](../../packages/runtime/src/sandbox/loadMiniAppFromUrl.ts) — option documentation.
- [packages/runtime/src/index.ts](../../packages/runtime/src/index.ts) and [packages/shared/src/index.ts](../../packages/shared/src/index.ts) — exports.
- [apps/host/src/App.tsx](../../apps/host/src/App.tsx) — load a real trust config; fail closed.
- [apps/host/src/miniapp/MiniAppHost.tsx](../../apps/host/src/miniapp/MiniAppHost.tsx) — surface a revoked refusal distinctly.
- [apps/host/scripts/build-signed-fixtures.ts](../../apps/host/scripts/build-signed-fixtures.ts) — emit JSON, add revoked/rotated fixture ids.
- Docs: [security/integrity.md](../security/integrity.md), [cli.md](../cli.md),
  [security/bridge.md](../security/bridge.md), the root README, and [docs/README.md](../README.md).

**Deliberately untouched** — and the fact that this list is this long is the main evidence the
scope is right:

- `packages/shared/src/integrity.ts` — no signature-format change.
- `packages/runtime/src/bridge/handlers/storageScope.ts`, `storage.ts`, `storageProvider.ts`,
  `indexedDbStorageProvider.ts`.
- `packages/runtime/src/bridge/dispatcher.ts` and every handler.
- `packages/sdk/**`, `packages/manifest/**`, `packages/ui/**`.
- `packages/runtime/src/bridge/storageIdCollision.test.ts`.

---

## Test plan

### Fail-before / pass-after, unit

Each of these must fail against `1604212` and pass at close-out.

1. A key marked `revoked` for a registered id → load **refused**. Fails before: `status` is
   unparseable today and the key is simply trusted.
2. Anti-downgrade: the revoked case yields `ok: false`, and no provenance — and therefore no
   storage scope — is produced for it.
3. Revoked is distinguishable from untrusted-key and from unsigned, by `code`.
4. An id whose keys are **all** revoked is still registered: an unsigned package claiming it is
   refused.
5. Rotation: old key `revoked`, new key `active`; signed by the new key → verified; signed by the
   old key → refused with the revoked code, not the untrusted-key code.
6. Rotation continuity: the verified scope key is unchanged before and after rotation, and the
   data written before is readable after.
7. Per-id scoping: a key revoked for one id and active for another behaves correctly for both.
8. `keyId` label matches, SPKI does not → not trusted.
9. Malformed / unknown-version / unknown-field trust config → rejected by the validator with
   issues, and no partial registration.
10. Migration: a revoked id is not selected as an adoption source.
11. **Regression:** a legacy `readonly string[]` entry behaves exactly as today.
12. **Regression:** the existing `packageVerification.test.ts` assertions pass unmodified.

### Browser e2e

New fixtures from `build-signed-fixtures.ts`, **URL-loaded with real provenance** — the Phase 10
lesson being that a `?scenario=` fixture path supplies no provenance and therefore proves nothing
about this layer:

1. A package signed by a revoked key is refused in a real browser, and the host reports *revoked*,
   not *untrusted key* and not *unsigned*.
2. A rotated package (new key active, old revoked) loads verified and **still reads its
   verified-namespace data** from real IndexedDB — the continuity claim in invariant 4.
3. A package whose key was revoked cannot read the verified-tier data it previously wrote.
4. A missing or invalid trust configuration makes the host refuse the URL load path and say why.

All 35 existing e2e specs must pass unmodified.

---

## Work items and commit boundaries

Machinery lands before the flip, for the same reason it did in Phase 10: no commit in history
should have the shape "a legitimate package stopped loading", because a commit `git bisect` lands
on that is indistinguishable from a regression.

| # | Commit | Scope |
|---|---|---|
| W1 | `feat(shared)` | `trustConfig.ts`: format, types, parser, validator. Unknown fields and unknown versions rejected. **Wired to nothing.** |
| W2 | `feat(runtime)` | `PackageTrustStore` widens to accept keyed entries; a bare string normalizes to `active`; `active` behaves exactly as today. Refusal `code` added for the existing paths, prose unchanged. **No new refusals.** Existing tests unmodified. |
| W3 | `feat(runtime)` | **The flip** — a `revoked` key refuses the load, with its own code, never downgrading. Registration stays presence-of-id. Anti-downgrade and all-revoked tests land here. |
| W4 | `test(runtime)` | Rotation continuity and migration: the verified namespace survives rotation; a revoked id is not an adoption source. No production code. |
| W5 | `feat(cli)` | `openmini trust validate`, sharing the W1 validator and the shared issue formatter. Tested through the built binary. |
| W6 | `feat(host)` | Host loads a real `openmini.trust.json`; refuses the URL load path if it is missing or invalid; fixture generator emits JSON and gains revoked/rotated fixtures; `MiniAppHost` surfaces the revoked state distinctly. |
| W7 | `test(e2e)` | Browser evidence, URL-loaded with real provenance, asserted against real IndexedDB. |
| W8 | `docs` | `integrity.md`, `cli.md`, `bridge.md`, the root README, `docs/README.md`. **Narrow** the carried-forward limitations rather than deleting them, and record the deferred work above. |

---

## Exit criteria

- `pnpm lint`, `pnpm format:check`, `pnpm build`, `pnpm typecheck` all pass.
- Unit tests: **at least 912**, all passing. No pre-existing test modified except where W2/W3
  require it, and any such modification is called out in its commit message with the reason.
- Browser e2e: **at least 35**, all passing, including the four new specs.
- `storageIdCollision.test.ts` unmodified and passing.
- Every invariant in "Invariants this phase must preserve" has at least one test naming it.
- Pushed to `main`, CI green, and the run recorded in this file at close-out.
- This file updated with the actual commit sequence, the verification table, the CI run link, and
  the limitations carried into Phase 12.

---

# What actually shipped

Everything below this line was written at close-out and is authoritative where it differs from
the plan above.

## Commit sequence

Base: `1604212` — Phase 10 W9 close-out.

| Commit | Item | Type | What it delivered |
| --- | --- | --- | --- |
| `23f7272` | — | `docs` | The approved plan above, recorded before implementation. |
| `ba7c0d3` | W1 | `feat(shared)` | [`trustConfig.ts`](../../packages/shared/src/trustConfig.ts): the `openmini.trust.json` format, types, parser, validator and issue formatter. Unknown fields and unknown versions rejected; `status` required, never inferred; the packages map built with a null prototype. **Wired to nothing** — no load outcome changed. |
| `16dfe90` | W2 | `feat(runtime)` | `PackageTrustStore` widened to `string \| TrustedKeyEntry` **per element**, with `normalizeTrustEntry` as the one place the legacy contract is written down. Refusal `code`s added over the refusals that already existed, every message byte-for-byte unchanged. **No behavioural change**; the provisional "a revoked key still loads" state pinned by a test so W3 would announce itself by breaking it. |
| `2c02e14` | W3 | `feat(runtime)` | **The flip.** A `revoked` key refuses the load with its own `revoked-key` code, returning *before* the trusted/untrusted question is asked, so it can never fall through to `untrusted-key`. Registration stays presence-of-id. Revocation wins over a contradictory `active` duplicate, and matches on SPKI rather than on `keyId`. |
| `ea8eb60` | W4 | `test(runtime)` | Rotation continuity and the revocation/migration edge, as an integration test over real keys → `verifyPackage` → `deriveStorageScope` → `resolveStorageScope` → a real provider. **No production code.** |
| `7ae50ca` | W5 | `feat(cli)` | `openmini trust validate [path]`, reusing W1's parser and formatter so the CLI and the host print identical text. Tested through the built binary, per the Phase 9 W5 precedent. |
| `64fe10a` | W6 | `feat(host)` | The host fetches a real `openmini.trust.json` at startup and **refuses the URL load path entirely** when it is missing or invalid. `PackageRefusalCode` propagated through `LoadMiniAppResult`; `describeRefusal` surfaces revoked distinctly; the fixture generator emits the JSON and gained the `revoked-key` and `storage-rotated` fixtures. |
| `425ff51` | W7 | `test(e2e)` | Fourteen browser cases over the four the plan called for, all URL-loaded with real provenance and asserted against real IndexedDB. **No production code.** |
| *this commit* | W8 | `docs` | Living documentation narrowed, and this file converted into the phase record. |

Machinery landed **before** the flip, for the reason Phase 10 recorded: no commit in history
should have the shape "a legitimate package stopped loading", because a commit `git bisect` lands
on that is indistinguishable from a regression. W1 and W2 changed no load outcome at all; W3 is
the single commit where one changes.

## What Phase 11 delivers, precisely

- **Operator-owned trust configuration.** `openmini.trust.json`, read by the host at startup,
  replacing a generated TypeScript module compiled into its bundle. A self-hoster registers an id
  by editing a file, not by editing source and rebuilding.
- **Revocation is supported.** A key registered for an id and marked `revoked` refuses the load,
  with its own `revoked-key` refusal code.
- **Key rotation with two overlapping valid keys is supported.** A successor `active` alongside a
  predecessor `revoked`: the successor verifies, the predecessor is refused *as revoked*.
- **A revoked key never downgrades** to `untrusted-key`, to `unsigned`, or to any permissive or
  unverified path. It produces no provenance, so no storage scope can be derived from it.
- **Verified storage remains keyed by manifest identity, never by `keyId`.** Phase 11 changed no
  part of the Phase 10 derivation; it proved the property holds across a rotation.
- **Revocation can make verified data temporarily unreachable, and never deletes it.** There is
  still no `delete` and no `clear` on the storage provider. Re-registering the id restores access.
- **A missing or invalid trust configuration disables the URL-loaded Mini App path**, and the host
  says why. It does **not** fall back to an empty trust store — which would register nothing, so
  nothing would fail closed, and an impostor of a registered id would load as merely unverified.
- **CLI validation.** `openmini trust validate`, sharing the host's parser and formatter.
- **Browser-level lifecycle evidence.** Fourteen e2e cases against real packages, real provenance
  and real IndexedDB.

### Legacy `readonly string[]` trust entries

`PackageTrustStore` widened from `Readonly<Record<string, readonly string[]>>` to accept
`string | TrustedKeyEntry` per element. A bare string still means exactly what it meant before
Phase 11 — a key that may sign — and normalizes to `{ publicKey, status: 'active' }`.

**The widening changed no legacy behaviour, and did so verifiably.** W2 moved the representation
and W3 changed the behaviour, in separate commits; every pre-existing refusal message is
unchanged; and the Phase 9 verification tests passed through W2 unmodified apart from two import
lines. A host part-way through rewriting its configuration — some entries bare strings, some
keyed — is a supported state, pinned by a regression test that uses both spellings in one entry
and by another that keeps a legacy string active alongside a revoked entry.

**Phase 11 deliberately sets no transition point.** The bare-string form is supported, not merely
tolerated. Deprecating or removing it belongs to whichever later phase first has a reason to
force it, and no deadline, warning or migration path is implied by this phase.

## Verification

Run locally at `425ff51` (W7) and re-run at W8 for the documentation-only change.

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | **1072 pass** (runtime 512, cli 179, shared 157, manifest 142, host 44, sdk 36, ui 2) |
| `pnpm e2e` | **49 pass**, Chromium — 35 pre-existing **unmodified**, 14 new |
| `pnpm format:check` | fails locally on a pre-existing CRLF artifact only — see below |

Unit tests grew 912 → 1072. Browser e2e grew 35 → 49. No pre-existing e2e spec was modified.

`storageIdCollision.test.ts` is unmodified and passing, as invariant 7 requires.

### Pre-existing test files modified, and why

Two, both called out in their own commit messages:

- **`packageVerification.test.ts`** (W3) — the `what W2 deliberately does not do yet` block was
  deleted. It existed to pin the provisional state so that W3 would announce itself by breaking
  it. It did. Thirteen tests replaced it.
- **`App.test.tsx`** (W6) — the host now fetches a trust configuration at startup, so the two
  existing tests had to answer that request; their previous mock served the manifest for every
  URL, which the parser rejects, which would have disabled the control they exercise. Only the
  mock routing changed; their assertions did not.

### Fail-before / pass-after

Every behavioural claim was checked by mutation rather than inferred from a green run. The
production code was reverted in each case and the tree confirmed clean before committing.

| Mutation | Effect |
| --- | --- |
| `packageVerification.ts` reverted to its W2 content | 8 W3 tests fail; 4 W4 tests fail |
| `deriveStorageScope` appends the `keyId` to the verified key | 7 W4 tests fail; 3 W7 browser cases fail |
| CLI replaces the shared formatter with its own wording | 6 W5 tests fail |
| Host substitutes `{}` for an unavailable trust configuration | 2 W6 tests fail, and 1 W7 browser case — the host fetches and loads the impostor |
| `trustStoreFromConfig` drops revoked keys while mapping | 2 W6 tests fail |
| `loadMiniAppFromUrl` drops the refusal `code` | 3 W6 tests fail |
| `describeRefusal` collapses revoked into the untrusted-key message | 1 W7 browser case fails |

W7's forced-submit case needed one extra check before it could be trusted: "the button is
disabled and nothing loaded" is also true of a broken page, so the technique was first run
against a *working* configuration to confirm it genuinely reaches the handler and fetches. It
does.

### Browser evidence (W7)

[`e2e/trust-lifecycle.spec.ts`](../../e2e/trust-lifecycle.spec.ts), every case driven through the
host's own "Load by URL" control against packages served from `public/miniapps/` and registered
through the same `openmini.trust.json` the host fetches at startup — never through `?scenario=`,
which supplies no provenance and so proves nothing about this layer.

| Property | Cases |
| --- | --- |
| A revoked key is refused **as revoked** | code is `revoked-key` and is neither `untrusted-key` nor `unsigned-registered`; the remedy text says re-sign rather than re-trust; no sandbox, iframe, provenance or storage scope is produced |
| Rotation keeps the verified namespace | successor loads verified; reads `v1:id:<id>` data from real IndexedDB; writes land in the id-named namespace and in neither the origin-bound nor the bare one; both eras survive a reload |
| Revocation strands rather than exposes | refused with the data still in `v1:id:<id>` afterwards; not spilled into the origin-bound namespace |
| No usable trust configuration refuses the path | missing and invalid both disable the control and say why; a forced submit past the disabled control fetches nothing; the same package *is* refused with a code when the configuration works; an unregistered, unsigned package cannot be loaded either, so the path itself is shut |

### CI

Pushed to `main` as `1604212..df58b54`.

| | |
| --- | --- |
| Head SHA | `df58b547aed2b1455e178dd9676e078ab89f22d9` (W8) |
| Run | [CI #16](https://github.com/Zhihaohu1996/openmini/actions/runs/37141422322), event `push` |
| `build` job | **success** — lint → format:check → build → typecheck → test |
| `e2e` job | **success** — Chromium |
| Result | **green** |

Both jobs ran against that exact SHA, not a later one.

The `build` job runs `pnpm format:check`, and it **passed on CI** while failing on the Windows
working tree. That is the CRLF diagnosis below confirmed from the other side: the committed
content is LF and clean, and the local failure is a checkout artifact.

## Limitations carried into future phases

Phase 11 narrowed the first of these. None of the rest moved.

1. **No remote trust distribution or registry.** *Narrowed, not closed.* Revocation and rotation
   exist as an explicit lifecycle in a file the operator owns, so a compromised key is retired by
   marking it `revoked` rather than by deleting it from source. There is still no registry, no
   remote trust distribution, no network-fetched revocation list, no CRL, no OCSP, no
   transparency log, no key discovery, and no PKI. The trust configuration is a local file;
   revoking a key affects the hosts whose file you edit and no others.
2. **No expiry or timestamp semantics.** `status` has two values and no validity window, and
   `expires` remains an unknown field rejected by both formats.

   Deferred deliberately, and the reason is the point. An expiry would make the load outcome
   depend on the **host's clock**, so a clock that is wrong or rolled back would re-admit a key
   the operator retired — weakest exactly when it matters. It also cannot establish *when*
   something was signed: without a trusted timestamp or some other freshness authority, an
   attacker keeps serving a package signed before the deadline, and the deadline says nothing
   about signing time. A revocation an operator writes down needs neither a clock nor an
   authority, which is why this phase shipped revocation instead.
3. **No trust on first use**, in any form. Third phase in a row.
4. **No real user or auth identity.** `user.getProfile()` is still a stub. Package identity is
   not user identity, and nothing in the trust configuration describes a person. Phase 11 did
   complete one precondition for it: the verified tier is entered by registration, and
   registration is now something an operator can actually perform.
5. **Same-origin collisions for unregistered packages remain**, and remain intentionally distinct
   from verified identity. Two *unsigned* packages served from one origin that both claim an id
   share a store; the origin tier separates packages without identifying them. Pinned by
   `storageIdCollision.test.ts`, unmodified.
6. **Signing-key custody is local-file based.** The private key is an unencrypted file written
   `0600`. Encrypting it still needs a KDF, a passphrase prompt and an answer for
   non-interactive CI.
7. **Concurrent multi-tab migration** (carried from Phase 10, untouched).
8. **Two stale docstrings** Phase 9 falsified (carried from Phase 10, untouched — out of scope by
   decision 4).
9. **Release, publishing and process work remains deferred** — no publishing workflow, no
   `SECURITY.md`, no CI matrix.
10. **Optional W11 — `.gitattributes` and CRLF normalization — was not implemented.** Excluded by
    decision 4 and invariant 10, and still excluded at close-out.

### The CRLF diagnosis, preserved

`pnpm format:check` fails on this Windows checkout, and did so before Phase 11 began. It is a
working-tree artifact, not content: `core.autocrlf=true` checks files out with CRLF, Prettier
reads them from the worktree and objects, while the committed blobs are LF and identical to what
CI checks out on Linux.

The diagnostic that settles it, and the one to use rather than reformatting: compare
`git hash-object <file>` against `git rev-parse HEAD:<file>`. Throughout Phase 11 these matched
for every file `format:check` named, each of which was a file the phase did not modify. CI runs
`format:check` on a Linux checkout and passes.

Reformatting those files locally would produce a diff that is pure line endings, touching files
outside the phase's scope. Adding `.gitattributes` is the real fix and is exactly what W11 would
be. Both were declined.
