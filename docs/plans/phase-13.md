# Phase 13 — guards that do not guard

**Status: approved, implementation in progress.** Approved on 2026-10-03 against base `da655fb`.

This file is the approved plan. It is written _before_ implementation deliberately, so that the
scope, ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. At close-out it becomes the phase record, in the same
form as [phase-9.md](phase-9.md), [phase-10.md](phase-10.md), [phase-11.md](phase-11.md) and
[phase-12.md](phase-12.md).

Living documentation for the delivered work will be
[security/integrity.md](../security/integrity.md). This file is the plan and then the history;
it is not updated as the code changes afterwards.

---

## Baseline

|                |                                                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| Base commit    | `da655fb` — Phase 12 close-out, CI recorded                                                                          |
| Working tree   | clean                                                                                                                |
| Unit tests     | **1119 pass** (runtime 538, cli 184, shared 160, manifest 142, host 57, sdk 36, ui 2)                                |
| Browser e2e    | **59 pass**, 21 spec files (Chromium)                                                                                |
| CI             | one workflow, `.github/workflows/ci.yml`: `build` job (lint → format:check → build → typecheck → test) and `e2e` job |

---

## Goal

Phases 9–12 built four layers on package verification: signing, verified-tier storage, an
operator-owned trust lifecycle, and a provenance-gated user identity. Discovery for Phase 13
found that one of the protections those layers rest on is **not enforced where the repository
believes it is**.

The repository already hardens object lookups against `Object.prototype` keys, deliberately and
with tests, in **four** places — the bridge dispatcher (Phase 8.5 R3), `capabilities.ts`,
`trustConfig.ts`'s packages map, and `trustStoreFromConfig`. Three sites were missed, and two of
them are in the signature path.

All three were verified during discovery, and the severity is **not** what the carried-forward
ledger implies. Stated precisely, because overstating it would be worse than leaving it:

- **This is not a signature bypass.** Integrity holds in every case — the digest comparison still
  fails closed.
- **It is**: a signed statement silently discarded, a documented coverage guarantee bypassed, a
  network fetch issued for a file the signature does not cover, a misleading error, and an honest
  package made unloadable.

### The three sites

| Site                                                                                        | Behaviour                                                                                                                                                                                                                                                                                                               | Reachability                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `integrity.ts:277`, written at `:303` — the signed-payload files map is a plain `{}`        | A payload entry named `__proto__` is **silently dropped**. `JSON.parse` _does_ create an own `__proto__` key, so `Object.entries` sees it; the assignment then hits the inherited setter, which ignores a string. Empirically confirmed.                                                                                 | Any signed package listing such a file                                                                                                                                                                                                             |
| `fetchResourceProvider.ts:141` — `this.digests?.[signedPath]`                               | Any `Object.prototype` key returns a truthy inherited value, so the _"refuse a file the signature does not mention **before fetching it**"_ check does not fire. The fetch is issued; the digest compare then fails with `resource does not match its signed digest` rather than `is not covered by the package signature`. | **Reachable on the real load path.** `entry: "__proto__"` passes manifest validation — [entryPath.ts](../../packages/manifest/src/rules/entryPath.ts) has no extension rule and no name rule — and `resolveEntryDocument` calls `readText(manifest.entry)`. |
| `packageVerification.ts:192` — `trustStore?.[manifestId]`                                   | `registeredKeys` becomes `Object`, `isRegistered` becomes true, then `.map()` on a function throws a `TypeError` out of a function documented to return an outcome.                                                                                                                                                      | Not via `loadMiniAppFromUrl` — `ID_PATTERN` requires a leading lowercase letter and a dot — but yes via the exported `verifyPackage`, whose `manifestId` is an unconstrained `string`.                                                              |

This is the whole of Phase 13. It is deliberately small.

### Why now, and why not the alternatives

**Why now:** four phases have been built on top of signature verification. A defect in the
signature payload parser should be closed before a fifth is added. It is also carried ledger item
10 in [phase-12.md](phase-12.md), and the `__proto__` case is separately recorded there as
deserving its own `fix(shared)` commit.

**Encrypted signing-key custody** is the deepest-carried item — four consecutive ledgers — and is
the natural Phase 14. It was deferred here because discovery showed its three stated blockers are
larger than they look: there is no prompt machinery, no stdin reading, no TTY check and **no
`process.env` use anywhere in the CLI**, so all three would be built from scratch, and the repo's
convention of testing through the built binary makes an interactive prompt awkward to cover. It
also deserves a settled answer to an objection first: for the CI case, a passphrase moves the
secret rather than removing it.

**The CI verification gap** — `build.test.ts:341` is the repository's only conditional test,
Windows-only, and has therefore never executed in CI despite guarding the `--out` containment
whose regression once deleted the project's own source tree. Same thesis, deliberately excluded:
it carries an unknown (whether `pnpm format:check` passes on a Windows runner, since `.prettierrc`
sets no `endOfLine`) that would force the `.gitattributes` decision declined four phases running.
Recorded as the leading Phase 14 candidate alongside key custody.

---

## Objective

Apply the repository's own own-property hardening to the three sites that were missed, and prove
the signature-coverage refusal fires before any network fetch.

## Invariants this phase must preserve

1. **No signature or verification outcome changes** for any well-formed package. Every existing
   `packageVerification.test.ts` and `integrity.test.ts` assertion passes unmodified.
2. **A file the signature does not cover is refused before it is fetched**, for every filename
   including `Object.prototype` keys. The fetch spy is the assertion, not the error message.
3. **A signed payload entry is never silently discarded.** If a payload lists a path, the parsed
   map contains it.
4. **`verifyPackage` returns an outcome for any string `manifestId`**, never throws.
5. No change to storage, migration, trust configuration, the user-identity gate, refusal codes, or
   sandbox lifetime.

## Non-goals

Stated so they cannot drift in:

- **No name blocklist.** `validateFilePath` and `checkEntryPath` are not changed to reject
  `__proto__`/`constructor`. The repository's own principle applies — _"a second door into the
  trust store is a second place for the rules to differ"_
  ([packageVerification.ts](../../packages/runtime/src/sandbox/packageVerification.ts)). Fixing the
  lookup fixes every name; a blocklist fixes the names someone remembered.
- No CI matrix, no `SECURITY.md`, no `.gitattributes`, no release work.
- No encrypted key custody, no multi-view routing, no binary bodies, no expiry.
- No change to the `MiniAppStorageProvider` interface.

---

## Work items and commit boundaries

| #   | Commit         | Scope                                                                                                                                                                                             |
| --- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | `fix(shared)`  | [integrity.ts](../../packages/shared/src/integrity.ts): build the payload files map with `Object.create(null)`. Closes the silent drop.                                                            |
| W2  | `fix(runtime)` | [fetchResourceProvider.ts](../../packages/runtime/src/sandbox/fetchResourceProvider.ts): `Object.hasOwn` gate on the digest lookup. The reachable site, and the only one where a guarantee is bypassed rather than a crash produced. |
| W3  | `fix(runtime)` | [packageVerification.ts](../../packages/runtime/src/sandbox/packageVerification.ts): `Object.hasOwn` gate on the trust-store lookup.                                                               |
| W4  | `test(runtime)`| Real-chain evidence: real key → real signature → `verifyPackage` → `createFetchResourceProvider` → `readText`, asserting the refusal fires **and no fetch was issued**. **No production code.**     |
| W5  | `docs`         | Narrow [integrity.md](../security/integrity.md), update the carried ledger, and convert this file into the phase record.                                                                           |

Three separate fix commits rather than one: they sit in two packages, have different reachability
and different severity, and each wants its own explanation. A `git bisect` landing between them
should still say something true.

### Reuse rather than reinvention

- The gate is [dispatcher.ts](../../packages/runtime/src/bridge/dispatcher.ts)'s pattern, including
  its reasoning that `hasOwn` alone and `typeof` alone are each insufficient. W2/W3 need only the
  `hasOwn` half, since the values are strings rather than callables — state that explicitly.
- The producer fix is `Object.create(null)`, matching
  [trustConfig.ts](../../packages/shared/src/trustConfig.ts) and `trustStoreFromConfig`.
- W4 follows the real-chain shape of
  [userIdentityGate.test.ts](../../packages/runtime/src/bridge/userIdentityGate.test.ts) and
  [trustLifecycleStorage.test.ts](../../packages/runtime/src/bridge/trustLifecycleStorage.test.ts).
- W1's test belongs in `integrity.test.ts`'s existing `describe('signed payload validation')`.
- The existing prototype-key tests in `trustConfig.test.ts`, `capabilities.test.ts` and
  `dispatcher.test.ts` are the house style to match.

### Why no browser e2e

Unlike Phases 10–12, nothing here is browser-specific: no provenance tier, no IndexedDB, no host
UI. The whole chain is exercisable in a unit-level integration test with a mocked `fetch`, and the
load-bearing assertion — _no fetch was issued_ — is easier to make there than in a browser. Serving
a fixture file literally named `__proto__` would mostly test Vite's static handling. Phase 10's "a
`?scenario=` fixture proves nothing" lesson was about provenance and does not apply.

---

## Test plan

### Fail-before / pass-after

Each mutation reverted and the tree confirmed clean before committing.

| Mutation                                              | Expected                                                                                             |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `integrity.ts` map reverted to `{}`                   | the `__proto__` round-trip test fails — the entry vanishes from the parsed payload                     |
| `fetchResourceProvider.ts` gate removed               | the coverage test fails **on the fetch spy**, and separately on the error message                      |
| `packageVerification.ts` gate removed                 | `verifyPackage({ manifestId: 'constructor', trustStore: {} })` throws `TypeError` rather than an outcome |
| W4's real-chain test run against the pre-W2 tree      | fails, proving it covers the real path and not just the unit                                           |

**A test-construction hazard worth recording**, found while writing W1: payload text must be built
as **raw JSON**, not with `JSON.stringify`. In an object literal a `__proto__:` key — quoted or
not — is the prototype-setter form and never becomes an own property, so
`JSON.stringify({ '__proto__': d })` emits `{}` and the case under test never reaches the parser.
`trustConfig.test.ts` and `packageVerification.test.ts` write raw JSON for the same reason.

### Gates

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (≥ 1119, no pre-existing test modified —
invariant 1 means none should need to be), `pnpm e2e` (59, all unmodified). `pnpm format:check`
will continue to fail locally on the pre-existing Windows CRLF checkout artifact in two untouched
files — verify with `git hash-object <file>` against `git rev-parse HEAD:<file>` and leave it
alone, as in Phases 9–12.

**End-to-end sanity in the real app:** `pnpm dev`, load a normal signed fixture by URL and confirm
it still loads verified — the regression this phase must not cause is "a legitimate package
stopped loading".

---

## Risks

1. **Over-claiming severity.** The honest framing above must survive into the commit messages and
   docs: integrity holds, nothing is bypassed, and calling this a vulnerability would be wrong.
2. **Scope creep into a name blocklist**, addressed in the non-goals.
3. **`Object.create(null)` maps and `JSON.stringify`/spread.** A null-prototype object is fine for
   both, but anything calling a method _on_ the map (`files.hasOwnProperty(...)`) would break. W1
   must check the map's consumers — `verified.payload.files` is read in `packageVerification.ts`
   and passed to `createFetchResourceProvider`.
4. **The W3 site is unreachable on the real path**, so its value is robustness at a public API
   boundary, not a closed hole. Say so rather than inflating it.

### Cut list, in order

1. W3 — the unreachable site. Defensible to defer; the other two are the substance.
2. W4's edge cases, keeping the two assertions that carry the argument.

---

## Exit criteria

- `pnpm lint`, `pnpm build`, `pnpm typecheck` pass; `pnpm format:check` fails only on the
  pre-existing CRLF artifact.
- Unit tests **at least 1119**, all passing, with no pre-existing test modified.
- Browser e2e **59**, all passing and unmodified.
- Every invariant above has at least one test naming it.
- Pushed to `main`, CI green on the exact pushed HEAD, and the run recorded in this file.
