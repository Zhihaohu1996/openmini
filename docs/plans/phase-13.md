# Phase 13 — guards that do not guard (completed)

**Status: closed.** Approved on 2026-10-03 against base `da655fb`; delivered in five work items,
W1–W5, and merged to `main` at `9a28ad9` with
[CI green](https://github.com/Zhihaohu1996/openmini/actions/runs/37244142201).

This file is the approved plan. It is written _before_ implementation deliberately, so that the
scope, ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. It is now the authoritative **phase record**, in the same
form as [phase-9.md](phase-9.md), [phase-10.md](phase-10.md), [phase-11.md](phase-11.md) and
[phase-12.md](phase-12.md). The plan text below is preserved as it was approved — including the
parts written in the future tense — with one prediction struck through and corrected in place,
because it did not hold. The outcome is recorded in
["What actually shipped"](#what-actually-shipped) at the end, which is authoritative where the
two differ.

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
| W4's real-chain test run against the pre-W2 tree      | ~~fails, proving it covers the real path and not just the unit~~ **Did not hold: all 9 pass.** On the real chain W1 alone already keeps inherited names out of the verifier's table; W2 still independently guards any table a caller passes to `createFetchResourceProvider` directly. W4 fails against the pre-W1 tree instead (7 of 9, on the fetch spy). See [the corrected table](#fail-before--pass-after-1). |

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

---

# What actually shipped

Everything below this line was written at close-out and is authoritative where it differs from
the plan above.

## Commit sequence

Base: `da655fb` — Phase 12 close-out, CI recorded.

| Commit        | Item | Type            | What it delivered |
| ------------- | ---- | --------------- | ----------------- |
| `c3b601c`     | —    | `docs`          | The approved plan above, recorded before implementation. |
| `dd1a81a`     | W1   | `fix(shared)`   | The signed-payload files map in [integrity.ts](../../packages/shared/src/integrity.ts) is built with `Object.create(null)`. A payload entry named `__proto__` is kept instead of silently dropped, and the map has no inherited members. |
| `eeb4631`     | W2   | `fix(runtime)`  | `Object.hasOwn` gate on the digest lookup in [fetchResourceProvider.ts](../../packages/runtime/src/sandbox/fetchResourceProvider.ts). A file the signature does not cover is refused before it is fetched, for every filename. |
| `d348258`     | W3   | `fix(runtime)`  | `Object.hasOwn` gate on the trust-store lookup in [packageVerification.ts](../../packages/runtime/src/sandbox/packageVerification.ts). `verifyPackage` returns an outcome for any string `manifestId` instead of throwing. |
| `dfa0eee`     | W4   | `test(runtime)` | [signatureCoverage.test.ts](../../packages/runtime/src/sandbox/signatureCoverage.test.ts): the coverage refusal over the real chain, with no digest table written by hand. **No production code.** |
| `9a28ad9`     | W5   | `docs`          | [integrity.md](../security/integrity.md) narrowed, the ledger carried forward, this file converted into the phase record. |

Three separate fix commits, as planned. Nothing was cut: W3, first on the cut list, shipped.

## What was closed, precisely

Stated with the same care as the plan, because overstating it would be worse than leaving it.
**None of these was a signature bypass.** Integrity held throughout: the digest comparison failed
closed whenever an inherited value reached it.

| Site | Before | After | Reachable on the real load path? |
| --- | --- | --- | --- |
| Payload files map (W1) | An entry named `__proto__` was silently dropped from a signed statement | Kept; the map has no prototype | Yes — any signed package listing such a file |
| Digest lookup (W2) | An `Object.prototype` name skipped the coverage refusal: the fetch went out, and the error said "does not match its signed digest" instead of "is not covered by the package signature" | Refused before any fetch, with the right reason | Yes, until W1 — `entry: "__proto__"` passes manifest validation |
| Trust-store lookup (W3) | An `Object.prototype` id read as registered: an unsigned package was refused as `unsigned-registered`; a signed one threw a `TypeError` | Treated as unregistered, like any other id the host never named | No — `ID_PATTERN` keeps these ids out of `loadMiniAppFromUrl`. Reachable only through the exported `verifyPackage` |

No name blocklist was added, per the non-goal. `__proto__` remains a legal file name and a legal
manifest entry, and a package that honestly signs such a file loads. W2 and W4 each test this.

## What Phase 13 did not change

Verified against the diff rather than asserted. `git diff da655fb..HEAD` touches these production
files and no others: `shared/src/integrity.ts`, `runtime/src/sandbox/fetchResourceProvider.ts`,
`runtime/src/sandbox/packageVerification.ts`. Each change is a lookup or a map constructor; no
signature, refusal code, message or exported type changed.

Untouched, confirmed by an empty diff: `loadMiniAppFromUrl.ts`, `trustConfig.ts`, the whole of
`bridge/` (storage, scoping, migration, the user handler), `packages/manifest/**`, the CLI, the
host app, and every e2e spec.

## Verification

| Gate | Result |
| --- | --- |
| `pnpm lint` | pass |
| `pnpm typecheck` | pass |
| `pnpm build` | pass |
| `pnpm test` | **1149 pass** (runtime 566, cli 184, shared 162, manifest 142, host 57, sdk 36, ui 2) |
| `pnpm e2e` | **59 pass**, 21 spec files, Chromium — all **unmodified** |
| `pnpm format:check` | fails locally on the pre-existing CRLF artifact only — see below |

Progression: 1119 → 1121 (W1) → 1128 (W2) → 1140 (W3) → 1149 (W4) → 1149 (W5, documentation
only). Browser e2e 59 throughout; this phase added no browser spec, for the reason given in
[Why no browser e2e](#why-no-browser-e2e).

### Pre-existing tests modified

**None.** Every test diff in this phase is additions only: `integrity.test.ts` (W1),
`fetchResourceProvider.test.ts` (W2) and `packageVerification.test.ts` (W3) gained new blocks
and lost no line, and `signatureCoverage.test.ts` (W4) is a new file.

### Invariants and their evidence

| Invariant | Evidence |
| --- | --- |
| 1. No outcome changes for a well-formed package | Every pre-existing `packageVerification.test.ts` and `integrity.test.ts` case passes unmodified; 59 browser specs load really-signed fixtures and pass unmodified; the manual check below |
| 2. Uncovered files refused before fetch, for every name | W2's `the digest table cannot reach Object.prototype` (over a caller-supplied table) and W4's `signature coverage over the real chain` (over the verifier's table), both asserting on the fetch spy first |
| 3. No signed payload entry silently discarded | W1's `keeps a payload entry named __proto__ rather than silently dropping it`, in `signed payload validation` |
| 4. `verifyPackage` returns an outcome for any string `manifestId` | W3's `the trust store cannot reach Object.prototype` — five ids, each asserted to resolve |
| 5. No change to storage, trust configuration, identity, refusal codes or sandbox lifetime | Not a test: the empty diff above |

The exit criterion asked for a test naming each invariant. Invariants 1 and 5 are about what did
not change, and their evidence is the unmodified suites and the empty diff, not a new test.

### Fail-before / pass-after

Each mutation was run with production source reverted, then restored and the tree confirmed clean
before committing. This table replaces the plan's where they differ.

| Mutation | Effect |
| --- | --- |
| `integrity.ts` map reverted to `{}` | 2 W1 tests fail (the entry is absent; a prototype key answers an object); 160 others pass |
| `fetchResourceProvider.ts` gate reverted | 5 W2 refusal cases fail **on the fetch spy** — the request went out — and separately on the message; 22 others pass |
| `packageVerification.ts` gate reverted | 10 W3 cases fail: 5 signed ids reject with `TypeError: (registeredKeys ?? []).map is not a function`; 5 unsigned ids come back `unsigned-registered`; 51 others pass |
| W4 against the **pre-W1** tree (`c3b601c`) | **7 of 9 fail.** All five prototype names and the unregistered-key case fail on the fetch spy. The genuine `__proto__` file fails too: the old parser dropped it and the bare lookup fetched it against an inherited value |
| W4 against the **pre-W2** tree (`dd1a81a`) | **0 of 9 fail.** The plan predicted failure; see below |
| W4 against HEAD with **only W1** reverted | 1 of 9 fails: the genuine `__proto__` file, refused as "not covered" because the parser dropped it |

Two of the plan's predictions were imprecise, and the record corrects both:

- **The W3 row.** The plan said `verifyPackage({ manifestId: 'constructor', trustStore: {} })`
  throws. That holds for a **signed** package only. An unsigned one returns a wrong refusal,
  `unsigned-registered`, and never reaches the `.map()` that throws. W3 tests both.
- **The W4 row.** The plan expected W4 to fail against the pre-W2 tree. All 9 pass there, and the
  prediction was wrong rather than the test. On the real load path the hole has **two closures,
  and either one alone holds it**: W1 means the verifier never hands the provider a map with
  inherited members, and W2 means the provider would not read them if it did. The W2 commit
  message had already said W1 "closes this for every digest table the verifier itself builds".
  W4 shows what it is for: it fails against the tree the phase started from, so it covers the
  real path, and its genuine-file case also catches W1 being lost on its own.

**This does not make W2 redundant.** W1 protects only the tables `verifyPackage` builds.
`createFetchResourceProvider` is exported and takes its digest table from the caller, and for any
table a caller supplies directly — a plain object literal, a parsed JSON file, anything not built
by the verifier — W2's gate is the only thing between an `Object.prototype` name and a network
request. W2's own five refusal cases prove exactly that: they pass a plain-object table and fail
on the fetch spy without the gate. The two fixes protect different inputs, and the real chain
happens to be the one input both cover.

### Manual check in the real app

As the plan required, before W3 was pushed: `pnpm dev` at `d348258`, the `signed-trusted` fixture
loaded through the host's own "Load by URL" control in Chromium. It reported `data-verified="true"`
with "verified: signed by trusted key …", ran to `status: ready` in an `allow-scripts` iframe,
fetched exactly `openmini.json`, `openmini.sig.json` and `index.html`, and logged no console
errors. The regression this phase had to avoid — a legitimate package that stopped loading —
did not happen. W4 added no production code, so the check stands for the final tree.

### CI

Phase 13 reached `main` in four pushes, ending at `9a28ad9`. Every run is green on both jobs,
each against the exact SHA pushed:

| Push | Head | Run | `build` | `e2e` |
| --- | --- | --- | --- | --- |
| `da655fb..eeb4631` (plan, W1, W2) | `eeb4631` | [CI #20](https://github.com/Zhihaohu1996/openmini/actions/runs/37238851740) | success | success |
| `eeb4631..d348258` (W3) | `d348258` | [CI #21](https://github.com/Zhihaohu1996/openmini/actions/runs/37240046639) | success | success |
| `d348258..dfa0eee` (W4) | `dfa0eee` | [CI #22](https://github.com/Zhihaohu1996/openmini/actions/runs/37240641134) | success | success |
| `dfa0eee..9a28ad9` (W5) | `9a28ad9` | [CI #23](https://github.com/Zhihaohu1996/openmini/actions/runs/37244142201) | success | success |

The final head is `9a28ad9b31ce80f43d08e19fcb03ccdf05456591`. On CI #23, `build` ran lint →
format:check → build → typecheck → test, and `e2e` ran `pnpm e2e` on Chromium; every step
succeeded, against that exact SHA and not a later one.

The `build` job runs `pnpm format:check` and passed on all four, while it fails on the Windows
working tree. This confirms the CRLF diagnosis below from the other side, for the third phase
running.

### The CRLF artifact, preserved

`pnpm format:check` fails on this Windows checkout and did so before Phase 13 began. It is a
working-tree artifact, not content: `core.autocrlf=true` checks files out with CRLF, Prettier
reads them from the worktree and objects, while the committed blobs are LF and identical to what
CI checks out on Linux. The two files it names —
`apps/host/src/miniapp/fixtures/hello-styled/src/index.html` and
`packages/runtime/src/bridge/handlers/storageScope.ts` — are not touched by this phase, and
`git hash-object <file>` matched `git rev-parse HEAD:<file>` throughout.

Phase 13 met one new form of it. Restoring a mutated file with `git checkout HEAD -- <file>`
writes it back with CRLF, so after W4's mutation runs `format:check` briefly named three more
files — the production files that had been swapped. Their blobs were identical to HEAD. Writing
the LF blob back with `git show HEAD:<file> > <file>` cleared it, without changing a byte of
content. `.gitattributes` remains the real fix and remains declined — a fifth phase running.

## Limitations carried into Phase 14

1. **No authentication of a person.** `user.getProfile()` relays a profile the host already has;
   nothing establishes identity (carried from Phase 12, unchanged).
2. **No persistence of user identity, and no per-user storage**; `MiniAppStorageProvider` still
   has no `delete` and no `clear` (carried from Phase 12, unchanged).
3. **No remote trust distribution or registry** — no CRL, no OCSP, no transparency log, no PKI
   (carried from Phase 11, unchanged).
4. **No expiry or timestamp semantics** (carried from Phase 11, unchanged).
5. **No trust on first use** — sixth phase running.
6. **Same-origin collisions for unregistered packages**, intentionally distinct from verified
   identity. `storageIdCollision.test.ts` unmodified.
7. **Signing-key custody is an unencrypted local file** at `0600` (carried from Phase 9). A
   leading Phase 14 candidate, with the blockers recorded in
   [Why now, and why not the alternatives](#why-now-and-why-not-the-alternatives).
8. **Concurrent multi-tab migration** (carried from Phase 10).
9. **Multi-view routing** — `navigation.close()` remains the whole of the navigation surface
   (carried from Phase 12, unchanged).
10. **The `Object.prototype` own-property guard.** _Closed for the signature and load path; two
    lower-severity sites remain, found at close-out._
    - **Closed by this phase:** the signed-payload files map (W1), the digest lookup (W2) and the
      trust-store lookup (W3). With the dispatcher, `capabilities.ts`, `trustConfig.ts` and
      `trustStoreFromConfig`, every lookup the close-out sweep found between a signature and a
      loaded package reads own properties only.
    - **Still open**, found by a close-out sweep for bare indexed lookups and confirmed by
      reading the code, not by running it:
      - `openmini verify` ([verify.ts](../../packages/cli/src/commands/verify.ts)) looks each
        signed path up in the on-disk digest map, which
        [packageFiles.ts](../../packages/cli/src/packageFiles.ts) builds as a plain `{}`. A
        payload listing `constructor` with no such file on disk is reported as `modified`
        instead of `missing`. It still fails; only the reason is wrong.
      - `StaticFixtureResourceProvider`
        ([resourceProvider.ts](../../packages/runtime/src/sandbox/resourceProvider.ts)) indexes
        its in-memory fixture map directly, so `readText('constructor')` would answer an
        inherited function instead of "not found". Its map is host-supplied fixture content, not
        a package, so no signature and no untrusted input is involved.
11. **No release or publishing workflow**, no `SECURITY.md`, no CI matrix.
12. **`.gitattributes` / CRLF normalization** remains optional and unimplemented.

## Found in discovery, deliberately out of scope and still open

- **`SandboxOptions.provenance` is dead API** (carried from Phase 12). `createSandbox.ts` never
  reads it; the copy that is read is `BridgeDispatcherOptions.provenance`.
- **The repository's only conditional test**, `build.test.ts`'s `it.runIf(unusedDriveLetter)`
  case, runs only on Windows and has therefore never executed in CI. It guards the `--out`
  containment whose regression once deleted `packages/` for real. A leading Phase 14 candidate
  alongside key custody, as recorded above.

The signed-payload `__proto__` defect that Phase 12 recorded here is **closed** by W1.
