# Phase 11 — trust lifecycle: operator-owned trust configuration, revocation and rotation

**Status: approved, implementation not started.** Approved on 2026-09-23 against base `1604212`.

This file is the approved plan. It is written *before* implementation deliberately, so that the
scope, ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. At close-out it becomes the phase record, in the same
form as [phase-9.md](phase-9.md) and [phase-10.md](phase-10.md).

Living documentation for the delivered system will be
[security/integrity.md](../security/integrity.md) and [cli.md](../cli.md). This file is the plan
and then the history; it is not updated as the code changes afterwards.

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
