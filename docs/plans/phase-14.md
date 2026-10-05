# Phase 14 — the signing side of the own-property guard

**Status: approved, implementation in progress.** Approved on 2026-10-04 against base `f1f1abf`.

This file is the plan. It is written _before_ implementation deliberately, so that the scope,
ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. At close-out it becomes the phase record, in the same
form as [phase-12.md](phase-12.md) and [phase-13.md](phase-13.md).

Living documentation for the delivered work will be
[security/integrity.md](../security/integrity.md) and [cli.md](../cli.md). This file is the plan
and then the history; it is not updated as the code changes afterwards.

---

## Baseline

|              |                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Base commit  | `f1f1abf` — Phase 13 close-out, CI recorded                                                                          |
| Working tree | clean                                                                                                                |
| Unit tests   | **1149 pass** (runtime 566, cli 184, shared 162, manifest 142, host 57, sdk 36, ui 2)                                |
| Browser e2e  | **59 pass**, 21 spec files (Chromium)                                                                                |
| CI           | one workflow, `.github/workflows/ci.yml`: `build` job (lint → format:check → build → typecheck → test) and `e2e` job |

---

## Goal

Phase 13 made every lookup between a signature and a loaded package read own properties only —
on the **runtime** side. Its close-out sweep recorded two leftover sites and described the CLI
one as a wrong reason in a failing report. Discovery for Phase 14 ran both against the real
binary and found that description **understated**: the signing side has the same defect Phase 13
W1 fixed in the runtime, and through it `openmini verify` reports a package as verified while it
contains a file its signature does not cover.

This phase closes that, and the two other confirmed own-property defects found alongside it.

### This is not a runtime signature bypass

Stated first, because overstating it would be worse than leaving it. **No package loads with
content its signature does not cover.** Since Phase 13, the runtime refuses to fetch any file the
signed payload does not list, for every file name, before issuing the request. Everything below
is about the **CLI** — the tool that produces signatures and the tool an operator uses to audit
them — and about a fixture-only runtime class. The worst case is false assurance from an audit
tool, not code execution or a bypass.

### What discovery found — five distinct behaviours

All five were reproduced against the built artifacts, not inferred. They are kept separate
because they differ in mechanism, in who sees them, and in severity.

**1. Signing-side file omission.** `openmini sign` silently drops a package-root file named
`__proto__`. A package with `openmini.json`, `index.html` and `__proto__` on disk signs as
`signed com.example.demo 1.0.0 (2 files)`, and the signed payload lists
`["index.html","openmini.json"]` only.

- _Mechanism:_ `digestPackageFiles` ([packageFiles.ts:108](../../packages/cli/src/packageFiles.ts))
  builds its map as a plain `{}`. Assigning `digests['__proto__'] = '<digest>'` reaches the
  inherited `__proto__` setter, which ignores a string — the entry is never created. This is the
  defect Phase 13 W1 fixed in the runtime's payload parser, present in the code that produces
  every payload.
- _Effect:_ fails closed, but silently. The file the author shipped is not covered; at load the
  runtime refuses to serve it, so a package whose `entry` is `__proto__` cannot load, with an
  error ("not covered by the package signature") that does not say why. `packageFiles.ts`'s own
  comment names this outcome as the thing that must never happen quietly: "skipping one silently
  drops a file the author put there".
- _Scope:_ the package root only. A nested `sub/__proto__` has the key `"sub/__proto__"`, which is
  an ordinary property.

**2. CLI verification false success.** A package signed normally, with a root file named
`__proto__` **added after signing**, passes `openmini verify`:
`…: verified (com.example.demo 1.0.0, 2 files)`, **exit 0**. The control — the same attack with a
file named `constructor` — is correctly refused as
`unsigned: constructor (present in the package but not covered by the signature)`.

- _Mechanism:_ the same plain `{}`. `verify` digests the on-disk files through `digestPackageFiles`,
  the `__proto__` file never enters that map, so the "present on disk but absent from the payload"
  loop ([verify.ts:87](../../packages/cli/src/commands/verify.ts)) never sees it.
- _Effect:_ the CLI's documented guarantee — "a file present on disk but absent from the payload
  is unattested content, and reported as a failure rather than ignored" — does not hold for this
  name. **This is the headline defect.** It is the CLI counterpart of Phase 13 W2's runtime
  guarantee, and it is what the shipped binary prints today.
- _Not a runtime bypass:_ a host loading that package still refuses to fetch the file.

**3. Incorrect missing-vs-modified diagnosis.** A package that signed a root file named
`constructor`, then had it deleted, is reported as `modified: constructor`. The control — an
ordinary `extra.js` signed then deleted — is correctly reported as
`missing: extra.js (listed in the signature but not in the package)`.

- _Mechanism:_ `onDisk[path]` ([verify.ts:73](../../packages/cli/src/commands/verify.ts)) on the
  plain map answers the inherited `Object` function instead of `undefined`, so the `missing`
  branch is skipped and `digestsEqual` fails on a length mismatch.
- _Effect:_ verification still fails; only the stated reason is wrong. This is the item Phase 13
  recorded, and the only one of the three it had seen.

**Items 1–3 share one root cause and one fix**: build the `digestPackageFiles` map without a
prototype. `onDisk` is that map, so the lookup at `verify.ts:73` then answers `undefined` for an
absent `constructor`, and the walk at `verify.ts:87` sees the `__proto__` entry.

**4. Command-dispatch behaviour.** `COMMAND_SPECS[command]`
([run.ts:266](../../packages/cli/src/run.ts)) is a bare lookup on a user-typed command name.

| Invocation | Today | Correct |
| --- | --- | --- |
| `openmini constructor --help` | prints `undefined`, **exit 0** | `unknown command`, exit 1 |
| `openmini __proto__ --help` | prints `undefined`, **exit 0** | `unknown command`, exit 1 |
| `openmini constructor --force` | `Cannot read properties of undefined (reading 'includes')`, exit 1 | `unknown command`, exit 1 |
| `openmini constructor`, `openmini toString x` | `unknown command`, exit 1 — correct, but only because a later `switch` default catches the inherited "spec" by accident | unchanged |

- _Effect:_ an unknown command can report **success**. Usability and scripting correctness only;
  no security property is involved.
- _Not affected:_ flags. `SHORT_ALIASES[raw]` is also a bare lookup, but discovery confirmed it
  already behaves correctly — `verify --constructor`, `verify --__proto__` and `verify -toString`
  each fail as `unknown flag`, exit 1, because an inherited value never matches a flag list.

**5. `StaticFixtureResourceProvider` contract violation.** `readText` is declared
`Promise<string>` and documented to reject for a path not in its map. For an `Object.prototype`
name it resolves with the inherited value instead:

| `readText(...)` | Result |
| --- | --- |
| `'index.html'` (in the map) | resolves, `string` |
| `'missing.html'` | rejects, `resource not found in fixture: missing.html` |
| `'constructor'` | **resolves**, `function` — `function Object() { [native code] }` |
| `'toString'` | **resolves**, `function` |
| `'__proto__'` | **resolves**, `object` — `[object Object]` |

`resolveEntryDocument` with `entry: "constructor"` over such a provider returns **`ok: true`**
with a function as `html`, which would become the iframe's `srcdoc`.

- _Mechanism:_ `this.files[key]` ([resourceProvider.ts:24](../../packages/runtime/src/sandbox/resourceProvider.ts)).
- _Reachability:_ exported from `@openmini/runtime`, but its only caller is the host's `?scenario=`
  demo path, where both the map keys and the manifests are host-authored. No package, signature
  or untrusted input reaches it. Its value is a correct public contract, not a closed hole.

### Why now, and why not the alternatives

**Why now:** Phase 13 closed this class of defect on the runtime side and recorded the CLI side
as a misreported reason. That record was wrong in the direction that matters — the CLI audit
tool reports success for an uncovered file — and the plan that follows a correction should be the
correction. It is also small: one root-cause line for items 1–3.

**Encrypted signing-key custody moves to Phase 15.** It was the leading Phase 14 candidate in
Phase 13's ledger, and its blockers are unchanged: no prompt machinery, no stdin reading, no TTY
check and no `process.env` use in the CLI. It is a feature; this is a defect in a shipped
security tool, and goes first.

**The CI verification gap** — `build.test.ts`'s `it.runIf(unusedDriveLetter)` case, which has
never executed in CI — stays carried. It still carries the `.gitattributes` decision with it.

---

## Objective

Make `openmini sign` cover every file it walks and `openmini verify` report every file it should,
for every file name; make CLI command dispatch and `StaticFixtureResourceProvider` read own
properties only; and prove the `verify` fix through the built binary.

## Invariants this phase must preserve

1. **No signed payload changes for a package without a prototype-named root file.** The map holds
   the same keys and digests, and `serializeIntegrityPayload` sorts its entries itself before
   writing them, so the payload JSON is byte-identical regardless of the map's prototype. The
   existing `emits file paths in a deterministic order` and `uses package-root-relative POSIX
   paths for nested files` tests pass unmodified.
2. **`sign` never silently omits a walked file.** The reported file count equals the number of
   files `listPackageFiles` returns, and the payload lists every one.
3. **`verify` reports every on-disk file the payload does not cover**, for every file name.
4. **`verify` reports a signed file absent from disk as `missing`**, for every file name.
5. **An unknown command never exits 0**, whatever follows it.
6. **`StaticFixtureResourceProvider.readText` resolves only with a string from its own map**, and
   rejects every other path with its existing message.
7. No change to the signature format, the runtime verification path, `loadMiniAppFromUrl`,
   `FetchResourceProvider`, trust configuration, storage, the bridge, or any refusal code.
8. Every existing test passes **unmodified**: unit and all 59 browser specs.

## Non-goals

Stated so they cannot drift in:

- **No `Object.hasOwn` checks in `verify.ts`.** The W1 producer fix is sufficient for both
  `verify.ts:73` and `verify.ts:87`, because `onDisk` _is_ the map W1 fixes and `payload.files`
  already has a null prototype since Phase 13 W1. A gate there would be speculative; it is added
  only if implementation or testing produces new empirical evidence that it is needed. The
  coupling is recorded under [Risks](#risks).
- **No change to `SHORT_ALIASES`** in `run.ts`. Discovery showed it already refuses
  prototype-named flags correctly; W2 changes only the lookup with demonstrated wrong behaviour.
- **No name blocklist.** `__proto__` and `constructor` remain legal file names. Fixing the map
  fixes every name; a blocklist fixes the names someone remembered. Same rule as Phase 13.
- **The bridge network handler's header map is excluded.** `readParams` in
  [network.ts](../../packages/runtime/src/bridge/handlers/network.ts) copies request headers into a
  plain `{}`, so a Mini App header named `__proto__` is silently dropped (confirmed: a copy of
  `{"__proto__":"x","constructor":"y"}` keeps only `constructor`). It fails toward sending less,
  sits in a different subsystem with its own header semantics, and is recorded as an open item
  for a later phase rather than fixed here.
- No encrypted key custody (Phase 15), no CI matrix, no `.gitattributes`, no `SECURITY.md`, no
  release work, no `SandboxOptions.provenance` cleanup.
- No change to Phase 12 or Phase 13 history or records. Phase 13's record understated item 3's
  neighbours; it stays as written, and this phase corrects the **living** documentation instead.

---

## Work items and commit boundaries

| #   | Commit          | Scope |
| --- | --------------- | ----- |
| W1  | `fix(cli)`      | [packageFiles.ts](../../packages/cli/src/packageFiles.ts): build the `digestPackageFiles` map with `Object.create(null)`. Closes items 1, 2 and 3. In-process tests in [sign.test.ts](../../packages/cli/src/commands/sign.test.ts), and the **built-binary integration test** for item 2 in [cli.binary.test.ts](../../packages/cli/src/cli.binary.test.ts). |
| W2  | `fix(cli)`      | [run.ts](../../packages/cli/src/run.ts): `Object.hasOwn` gate on the `COMMAND_SPECS` lookup. Closes item 4. Tests in [run.test.ts](../../packages/cli/src/run.test.ts). |
| W3  | `fix(runtime)`  | [resourceProvider.ts](../../packages/runtime/src/sandbox/resourceProvider.ts): `Object.hasOwn` gate in `StaticFixtureResourceProvider.readText`. Closes item 5. Tests in [resourceProvider.test.ts](../../packages/runtime/src/sandbox/resourceProvider.test.ts). |
| W4  | `docs`          | Documentation close-out: correct [integrity.md](../security/integrity.md)'s "Not yet covered" CLI paragraph, which understates item 2; note in [cli.md](../cli.md)'s `openmini verify` section, whose result table promises every file is reported as `modified`, `missing` or `unsigned`, that this now holds for every file name; carry the ledger forward; convert this file into the phase record; run the final local verification. CI for W4's own SHA is marked **pending** in the record, because it cannot exist until W4 is pushed. |
| —   | `docs`          | **CI-record follow-up — not a work item.** Created only after W4 is pushed and CI on W4's exact SHA has completed green. Replaces the pending row with that run and sets the status to closed. Nothing else. See [Close-out sequence](#close-out-sequence). |

Three separate fix commits: two packages, three different behaviours, three different severities.
A `git bisect` landing between them should still say something true. W1, W2, W3 and W4 are four
separate commits, and the CI-record follow-up is a fifth commit that is not a work item.

### Close-out sequence

The order the phase ends in, made explicit because one step depends on a fact that only exists
after the step before it is pushed:

1. **W1, W2, W3** — each committed separately, each with its own gates and mutation evidence.
   Pushed when the user approves, singly or together.
2. **W4** — the documentation close-out, committed after its final local verification. Its record
   lists CI for every earlier push and marks CI on W4's own SHA as pending.
3. **Push W4**, then wait for the CI run triggered by **W4's exact SHA** to complete. If either job
   fails, stop and report; nothing is recorded as green.
4. **CI-record follow-up** — only once that run is green: a separate, minimal `docs` commit
   (`docs: record the Phase 14 CI result (Phase 14 close-out)`), touching this file only, as
   `da655fb` did for Phase 12 and `f1f1abf` for Phase 13. It replaces the pending row with the
   run's number, link and per-job conclusions, and changes the status line to closed. It is not
   another implementation work item, changes no code, tests or other documentation, and does
   **not** start Phase 15.
5. **Push the follow-up** and verify the CI run it triggers, once, on its exact SHA. That run is
   **not** recorded by yet another commit — the record cites the run for the commit it describes,
   which is W4's. Recording each record's own CI would never terminate.

Phase 14 is closed when step 5's run is confirmed green.

### W1 in detail

Production: one line, plus a comment in the house style — what the plain object did, why the
null prototype fixes both consumers, and that the type `PackageFileDigests` is unchanged.

In-process tests, in `sign.test.ts`'s existing `signPackage` and `verifyPackage` describes:

| Test | Asserts | Item |
| --- | --- | --- |
| `sign` covers a root file named `__proto__` | `fileCount` is 3; the parsed payload's `files` has an own `__proto__` key whose digest matches the file | 1 |
| `verify` accepts an honest package containing `__proto__` | `ok: true` — the positive control: the fix does not refuse what it now covers | 1 |
| `verify` reports a root `__proto__` file added after signing | `ok: false`, report contains `unsigned: __proto__` | 2 |
| `verify` reports a signed `constructor` file deleted after signing as `missing` | report contains `missing: constructor`, and does **not** contain `modified: constructor` | 3 |

The payload is inspected with `verifySignatureFile` from `@openmini/shared` (already imported by
the file), and the presence of `__proto__` is asserted with `Object.hasOwn`, never with an index
or `toHaveProperty`, which would be satisfied by the inherited member.

**Built-binary integration test**, in `cli.binary.test.ts`'s `keygen / sign / verify` describe,
through the existing `runCli` helper that spawns `dist/cli.js`:

- `keygen` → `sign` a package → write a root file named `__proto__` → `verify`;
- assert `verify` exits **1**, not 0, and that its output names `unsigned: __proto__`.

This is the item the user-visible tool gets wrong today, so it is proved where the user meets it.
The suite already refuses to run without a built `dist/`, and CI builds before testing.

### W2 in detail

Production: `const spec = Object.hasOwn(COMMAND_SPECS, command) ? COMMAND_SPECS[command] : undefined;`
with a comment in the dispatcher's style, noting that the values are plain spec objects so `hasOwn`
is the whole of it, and that `SHORT_ALIASES` is deliberately left alone because it is already
correct.

Tests, in `run.test.ts`'s existing `exit codes` describe:

| Test | Asserts |
| --- | --- |
| `constructor --help` and `__proto__ --help` | `run` returns **1**, and `unknown command` is reported — not `undefined` and not 0 |
| `constructor --force` | `run` returns 1 with `unknown command`, rather than rejecting with a `TypeError` |
| `toString x` | returns 1 — passes today too, by accident; kept as the control that the accident is no longer load-bearing |
| a real command with `--help` (e.g. `build --help`) | still exits 0 with its usage — the positive control |

### W3 in detail

Production: `Object.hasOwn(this.files, key) ? this.files[key] : undefined`, with a comment that the
class is exported and its contract is `Promise<string>`.

Tests, in `resourceProvider.test.ts`'s existing `StaticFixtureResourceProvider` describe:

| Test | Asserts |
| --- | --- |
| `constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__` (parameterised) | `readText` **rejects** with `resource not found in fixture` |
| a map with a genuine own `__proto__` key | served — built with `Object.create(null)` and assignment, never an object literal, for the reason Phase 13 recorded |
| `resolveEntryDocument` with `entry: "constructor"` | `ok: false`, not `ok: true` with a function |

### Reuse rather than reinvention

- The producer fix is `Object.create(null)`, matching Phase 13 W1 in
  [integrity.ts](../../packages/shared/src/integrity.ts), [trustConfig.ts](../../packages/shared/src/trustConfig.ts)
  and `trustStoreFromConfig`.
- The lookup gates are `Object.hasOwn`, matching Phase 13 W2/W3, the dispatcher and
  `capabilities.ts`.
- Fixtures containing `__proto__` are built on real files (CLI) or on a null-prototype object with
  assignment (runtime). Never an object literal and never `JSON.stringify`: there a `__proto__:` key
  is the prototype-setter form and never becomes an own property — recorded in Phase 13's plan.
- Every refusal test asserts the **outcome** (exit code, `ok`, rejection) before the message, as
  Phase 13's tests asserted the fetch spy first.

### Why no browser e2e for the defects

Nothing here is browser-specific. Items 1–4 live in the CLI, which no browser runs; item 5 is a
class whose inputs are host-authored, and its behaviour is fully observable in a unit test. A
browser spec would need a fixture literally named `__proto__` served by Vite, which mostly tests
Vite. **The existing 59 specs remain a regression gate**: they load signed fixtures and the
`?scenario=` demos — the latter through `StaticFixtureResourceProvider` — and must all pass
unmodified.

---

## Test plan

### Fail-before / pass-after

Every mutation is reverted and the tree confirmed clean before the commit. Mutation runs are done
**after** the fix and its tests are written, so the expected effect is that the new tests fail
and every other test still passes.

| Mutation | Expected |
| --- | --- |
| W1: `digestPackageFiles` map reverted to `{}` | all three refusal-side in-process tests fail — the payload lacks `__proto__` and the count is 2 (item 1); the late `__proto__` file is not reported (item 2); the deleted `constructor` reads `modified` (item 3). The honest-package positive control **passes** either way — it guards against over-refusal, not the hole — and is reported as such |
| W1: same mutation, built-binary test | after rebuilding `dist/` with the mutation: `verify` exits **0** and prints `verified`, so the test fails on the exit code. Rebuild again after restoring |
| W2: `hasOwn` gate removed | the `--help` cases return **0** and the `--force` case rejects with `Cannot read properties of undefined (reading 'includes')`; the `toString x` control and the real-command control still pass |
| W3: `hasOwn` gate removed | all five parameterised cases **resolve** instead of rejecting; `resolveEntryDocument` returns `ok: true`; the genuine-`__proto__` case still passes |

The binary mutation needs a rebuild because `cli.binary.test.ts` spawns `dist/cli.js`, not the
source. The run order is: mutate source → `pnpm --filter @openmini/cli build` → run the binary test
→ restore source → rebuild → confirm the binary test passes again.

### Restoring after a mutation — without CRLF churn

Learned in Phase 13 W4: on this checkout `core.autocrlf=true`, and restoring a file with
`git checkout HEAD -- <file>` writes it back **with CRLF**, which `pnpm format:check` then flags
although the content is identical. So:

- **Mutating an uncommitted fix** (W1–W3 mutations): copy the fixed file to the session
  scratchpad first, mutate, run, then copy it back. Confirm `git hash-object <file>` matches the
  saved copy's hash.
- **Reverting to a committed state**: write the blob back with `git show HEAD:<file> > <file>`,
  which produces LF, and confirm `git hash-object <file>` equals `git rev-parse HEAD:<file>`.
- **Never** `git checkout -- <file>` or `git restore` for a mutation.
- If `git status` still shows a phantom ` M` while `git diff --quiet` exits 0, `git add <file>`
  refreshes the index stat without changing the blob; confirm with `git diff --cached --quiet`
  before committing.

### Gates

`pnpm lint`, `pnpm typecheck`, `pnpm build`, `pnpm test` (≥ 1149, no pre-existing test modified),
`pnpm e2e` (59, all unmodified).

`pnpm format:check` will continue to fail locally on the pre-existing Windows CRLF artifact in
two untouched files — `apps/host/src/miniapp/fixtures/hello-styled/src/index.html` and
`packages/runtime/src/bridge/handlers/storageScope.ts`. Verify with `git hash-object <file>`
against `git rev-parse HEAD:<file>` and leave them alone, as in Phases 9–13. CI checks out LF on
Linux, and its `format:check` has passed on every Phase 12 and Phase 13 run. Any **third** file
it names is new and must be explained before committing, not ignored — in Phase 13 that was
mutation-restore residue.

**Manual check with the real CLI**, after W1 and W2: rerun discovery's scratchpad session against
the built binary — sign a package containing `__proto__`; add `__proto__` after signing; delete a
signed `constructor`; the two ordinary-file controls; and the four `run.ts` invocations above —
and record each output in the phase record. The regression this phase must not cause is "a
legitimate package stopped signing or verifying", so the ordinary controls matter as much as the
fixed cases. `pnpm dev` is not needed: W3's only host caller is covered by the e2e scenario specs.

---

## Risks

1. **Over-claiming severity.** None of this is a runtime signature bypass, and the commit messages
   and docs must say so. Item 2 is false assurance from an audit tool; items 3–5 are wrong reasons,
   a wrong exit code and a broken contract.
2. **The `verify.ts` coupling is accepted, not removed.** `verify.ts:87` relies on `payload.files`
   having a null prototype (Phase 13 W1, in `@openmini/shared`), and `verify.ts:73` will rely on
   `onDisk` having one (this phase's W1). A regression of either is caught by that package's own
   tests — Phase 13's `integrity.test.ts` cases, and W1's new `sign.test.ts` cases — so no
   speculative gate is added. If implementation finds a path where that is not true, the gate is
   added with the evidence, as a stated deviation.
3. **Null-prototype map consumers.** A map from `Object.create(null)` has no methods. W1 must check
   every consumer of `digestPackageFiles`' result — `sign.ts` passes it to `signIntegrityPayload`
   and calls `Object.keys`; `verify.ts` indexes it and calls `Object.keys` — and confirm none calls
   a method _on_ the map.
4. **Payload byte stability.** Invariant 1 rests on `serializeIntegrityPayload` sorting the
   entries (`Object.entries(...).sort(...)` into `Object.fromEntries`), which reads own enumerable
   properties and so behaves identically on a null-prototype map. The existing ordering test pins
   it; it must pass unmodified.
5. **Platform file names.** The tests create files named `__proto__` and `constructor`. Both are
   legal on Windows, macOS and Linux, and discovery created both on this Windows checkout. No case
   collision is involved.
6. **Binary test staleness.** `cli.binary.test.ts` tests `dist/`, which is stale until rebuilt. The
   gates run `pnpm build` before `pnpm test`, as CI does.
7. **Scope creep.** The header map (excluded above), `SHORT_ALIASES`, and further sweeps are
   recorded, not fixed.

### Cut list, in order

1. W3 — fixture-only inputs; a contract fix, not a closed hole.
2. W2 — a wrong exit code, no security property.

W1 and its built-binary test are the substance and are not cut.

---

## Exit criteria

- `pnpm lint`, `pnpm build`, `pnpm typecheck` pass; `pnpm format:check` fails only on the
  pre-existing CRLF artifact in the two files named above.
- Unit tests **at least 1149**, all passing, with no pre-existing test modified.
- Browser e2e **59**, all passing and unmodified.
- The built-binary test exists and fails against a binary built from the W1 mutation.
- Every invariant above has evidence recorded against it — a test, or for invariants 7 and 8 the
  empty diff and the unmodified suites.
- The manual CLI check is recorded.
- W4 committed after the gates above pass locally, and pushed to `main`.
- CI green on **W4's exact SHA** — both `build` and `e2e` — and that run recorded in this file by
  the separate CI-record follow-up commit described in
  [Close-out sequence](#close-out-sequence).
- The follow-up pushed, and the CI run on **its** exact SHA confirmed green once. That run is
  verified but deliberately not recorded by a further commit.

---

## Carried forward from Phase 13, and where each stands

| # | Item | Phase 14 |
| --- | --- | --- |
| 1 | No authentication of a person | carried, unchanged |
| 2 | No persistence of user identity, no per-user storage | carried, unchanged |
| 3 | No remote trust distribution or registry | carried, unchanged |
| 4 | No expiry or timestamp semantics | carried, unchanged |
| 5 | No trust on first use | carried, unchanged — seventh phase running |
| 6 | Same-origin collisions for unregistered packages | carried, unchanged |
| 7 | Signing-key custody is an unencrypted local file | **moved to Phase 15** as its leading candidate |
| 8 | Concurrent multi-tab migration | carried, unchanged |
| 9 | Multi-view routing | carried, unchanged |
| 10 | The `Object.prototype` own-property guard | **this phase**: the CLI digest map (W1), CLI dispatch (W2) and the fixture provider (W3). The bridge header map stays **open** |
| 11 | No release or publishing workflow, no `SECURITY.md`, no CI matrix | carried, unchanged |
| 12 | `.gitattributes` / CRLF normalization | carried, unchanged — sixth phase running |

Still open from discovery, unchanged: `SandboxOptions.provenance` is dead API, and the
repository's only conditional test (`build.test.ts`, Windows-only) has never executed in CI.

New open item recorded by this plan: **the bridge network handler drops a request header named
`__proto__`** (see [Non-goals](#non-goals)).
