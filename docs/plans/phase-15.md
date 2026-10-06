# Phase 15 — signing-key custody, hardened before it is encrypted

**Status: approved, implementation not started.** Approved on 2026-10-06 against base `408c988`.

This file is the plan. It is written _before_ implementation deliberately, so that the scope,
ordering, invariants and exit criteria survive across sessions and do not have to be
reconstructed from conversation memory. At close-out it becomes the phase record, in the same
form as [phase-13.md](phase-13.md) and [phase-14.md](phase-14.md).

Living documentation for the delivered work will be [cli.md](../cli.md),
[security/integrity.md](../security/integrity.md) and [security/bridge.md](../security/bridge.md).
This file is the plan and then the history; it is not updated as the code changes afterwards.

---

## Baseline

|              |                                                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------------------------------- |
| Base commit  | `408c988` — Phase 14 close-out, CI recorded                                                                          |
| Working tree | clean                                                                                                                |
| Unit tests   | **1166 pass** (runtime 573, cli 194, shared 162, manifest 142, host 57, sdk 36, ui 2), as recorded at Phase 14 W4    |
| Browser e2e  | **59 pass**, 21 spec files (Chromium)                                                                                |
| CI           | one workflow, `.github/workflows/ci.yml`: `build` job (lint → format:check → build → typecheck → test) and `e2e` job |

Phase 14's last two runs: CI #29 on W4 `cdd2f35`, recorded in its phase record, and CI #30 on
the close-out `408c988`, verified green on both jobs and deliberately not recorded.

---

## Goal

Phase 14 named **encrypted signing-key custody** (its ledger item 7) as this phase's leading
candidate. Discovery for Phase 15 examined the key lifecycle that encryption would sit on, and
found that **today's unencrypted key handling has three confirmed defects**. Encryption fixes none
of them, and two would carry over to an encrypted key unchanged. So this phase hardens the key
handling that exists, closes the two remaining own-property sites, and settles line-ending
normalization. Encryption is deferred to a phase that starts from a written design.

### This is not a signature bypass

Stated first, as in Phase 14. Nothing below lets a package load with content its signature
does not cover, or lets an untrusted key pass as trusted. K1 and K2 concern the secrecy of the
**signer's own private key**, through the CLI's write path and through operator misuse that the
docs already warn against. K3 is a wrong-time failure that fails closed. N1 and N2 fail closed or
toward sending less. R1 is a latent checkout hazard that CI cannot see.

### What discovery found

**K1 — `keygen --force` drops both write protections.**
[keygen.ts:62-71](../../packages/cli/src/commands/keygen.ts) writes with
`flag: options.force ? 'w' : 'wx'` and `mode: 0o600`.

- _Mechanism:_ `mode` applies only when a file is created, so overwriting an existing `0644`
  file leaves the new private key `0644`. `'w'` follows a symlink at the path, which the
  exclusive `'wx'` open would refuse. It also truncates in place, so a crash mid-write loses the
  old key with nothing written.
- _Docs:_ the comment at `keygen.ts:67-68` ("the key is never briefly world-readable") and
  [cli.md:223-225](../cli.md) are true only for the non-`--force` path.
- _Evidence:_ code read, and Node's documented `writeFile` mode semantics. POSIX-only: it cannot
  be observed on this Windows checkout, where Node ignores the mode.
- _Severity:_ medium. A private key ends up with the wrong mode, from a documented flag.

**K2 — `sign` will sign the private key into the package.**

- _Mechanism:_ `digestPackageFiles` ([packageFiles.ts](../../packages/cli/src/packageFiles.ts))
  excludes only `openmini.sig.json`, and `signPackage`
  ([sign.ts](../../packages/cli/src/commands/sign.ts)) never checks where `--key` is.
  `openmini sign dist --key dist/key.json` covers the key file, and `verify` then reports
  `verified`.
- _Guard today:_ prose only ("Keep it out of your package directory", [cli.md](../cli.md)).
- _Evidence:_ code read. A reproduction through the built binary is W2's first step.
- _Severity:_ high-impact misuse. A published package would carry its signer's private key.

**K3 — `sign` does not check that the key file's `publicKey` matches its `privateKey`.**

- _Mechanism:_ `signPackage` passes the file's SPKI straight to `signIntegrityPayload`. An edited
  or mismatched key file gives exit 0 and an `openmini.sig.json` that every verifier refuses.
- _Severity:_ low. It fails closed, but at the wrong time and with the wrong message.

**N1 — the host's `?trust=` lookup is a bare prototype lookup.**
[apps/host/src/miniapp/trustConfig.ts:55-56](../../apps/host/src/miniapp/trustConfig.ts) returns
`TRUST_CONFIG_SOURCES[requested] ?? TRUST_CONFIG_SOURCES.default` over a plain object literal.

- _Reproduced_ in memory with the exact code:

  | Query | Returns | Fetches |
  | --- | --- | --- |
  | `?trust=missing` | `'/openmini.trust.absent.json'` | as intended |
  | `?trust=https://evil` | `'/openmini.trust.json'` | correct fallback |
  | `?trust=constructor` | **function** `Object` | `/function%20Object()…` |
  | `?trust=toString` | **function** | `/function%20toString()…` |
  | `?trust=__proto__` | **object** `Object.prototype` | `/[object%20Object]` |

- _Effect:_ fails closed. The host lands in `unavailable`, which `?trust=missing` already does by
  design, and no attacker URL is reachable. It contradicts the function's own "an allowlist rather
  than a free parameter" comment and its `: string` return type.

**N2 — the bridge network handler drops a header named `__proto__`** (open since Phase 14).
`readParams` in [network.ts:113-124](../../packages/runtime/src/bridge/handlers/network.ts)
copies request headers into a plain `{}`. `collectResponseHeaders` (`:199-205`) does the same for
response headers.

- _Reproduced:_ a copy of `{"__proto__":"x","constructor":"y"}` keeps only `constructor`.
  `new Headers().set('__proto__', 'x')` is accepted, so it is a legal header name: `_` is a token
  character.
- _Effect:_ fails toward sending less. There is no prototype pollution, because values are always
  strings, and the blocked-header check runs before the assignment, so it is not bypassed.

**R1 — a CRLF checkout breaks a committed CSP hash.**

- _State:_ all 225 index blobs are LF, there is no `.gitattributes`, and the system gitconfig
  sets `core.autocrlf=true`. Two working-tree files on this checkout are CRLF: the
  `format:check` residue recorded since Phase 9.
- _Reproduced:_ `apps/host/public/miniapps/hello-remote/index.html` pins its inline script with
  `script-src 'sha256-qDoWMWIkHxNeKjGkB1Wu+TncdfFIlLoueXJYRKEVuXo='`. Hashing the committed
  script body gives that value with LF line endings, and
  `8E2KjGe9/8pLcgS5Nkr6M/hQElKamXGUxTxhNVggKOg=` with CRLF.
- _Effect:_ on a fresh Windows clone the browser would silently refuse that script.
  `remote-load-roundtrip.spec.ts` would be expected to fail there (inferred, not run). The signed
  fixtures are unaffected, because they are generated in the same run that loads them.
- _Why it matters now:_ this is a stronger reason for `.gitattributes` than the `format:check`
  noise every phase since Phase 9 has cited.

### Also found, and not in this phase's scope

- **T1 — the cross-drive `--out` guard has never run in CI.** The `isAbsolute(rel)` clause in
  `resolveOutDir` ([build.ts:58](../../packages/cli/src/commands/build.ts)) is unreachable on
  POSIX. Its only test is the Windows-only `it.runIf` case in `build.test.ts`, so deleting the
  clause leaves Linux CI green. This is a test gap, not a defect: the guard is correct. It stays
  carried, and after W6 it no longer carries the `.gitattributes` decision with it.
- **T2 — `NETWORK_TIMEOUT` is unreachable for a default-configured guest.** The SDK's
  `requestTimeoutMs` defaults to 10 s ([sdk client.ts:51](../../packages/sdk/src/bridge/client.ts)),
  and the host's network deadline is 30 s. A slow request therefore gets `REQUEST_TIMEOUT` at
  10 s, while [bridge.md](../security/bridge.md)'s error table documents `NETWORK_TIMEOUT`. The
  host request keeps its in-flight slot until it finishes. Settling this needs a design choice,
  so it is recorded rather than fixed.
- **`SandboxOptions.provenance` is dead API**, confirmed: it is declared in `sandbox/types.ts` and
  never read, and its only caller is `MiniAppHost.tsx`. Removing it is a public-type change with
  no runtime effect, and is deferred.

### Checked and not a defect

- **The Phase 14 blockers for encryption still hold.** There is no `process.env`, stdin, `isTTY`
  or `readline` use anywhere in `packages/` or `apps/`, and no I/O seam: `run()` writes to
  `console`, and tests spy on it.
- **Key material is never logged.** Error messages carry paths only, and the imported signing key
  is non-extractable.
- **The remaining lookups found by the own-property sweep are safe by construction.**
  - `dev.ts`'s `CONTENT_TYPES` lookup: keys come from `extname`.
  - `verify.ts`'s `onDisk[path]` and `in payload.files`: both maps are null-prototype.
  - `trust.ts`, `validateManifest.ts` and `dispatcher.ts`.
  - The fixed-name `in` checks.
  - `run.ts`'s `SHORT_ALIASES` and `parseArgs`.
  - The Phase 13 and 14 sites remain guarded.
- **Storage has no delete or clear.** That is a deliberate missing feature, not a broken promise:
  the interface says so, and neither the SDK nor the docs offer removal.

### Docs drift, confirmed

- [cli.md](../cli.md)'s top synopsis omits `init … [--force]`, which its own `init` section and
  `run.ts` have.
- `cli.md` claims `0600` with no Windows caveat. On Windows Node ignores the mode, and the file
  inherits the directory's ACL.
- The key-file format (`keyVersion`, `algorithm`, `keyId`, base64 PKCS#8 and SPKI) is documented
  nowhere.
- The top-level README says "Status: Phase 12" and describes the CLI as scaffold, validate, build
  and serve only.
- The titles of `docs/README.md`'s entries, `cli.md` and `integrity.md` stop at Phase 11 or 13.
- [bridge.md](../security/bridge.md) calls the quota race "slightly over the cap". The worst case
  is about 31 × (512 + 8192) bytes, roughly 51% over, per dispatcher, which allows 32 in-flight
  requests.

### Why not encryption now

1. **It fixes none of K1–K3.** An encrypted key written through the `--force` path gets the same
   wrong mode and the same symlink follow, and an encrypted key can still be signed into a
   package.
2. **Its recorded objection is still unanswered.** [Phase 13](phase-13.md) recorded that "for the
   CI case, a passphrase moves the secret rather than removing it". Answering it means choosing a
   passphrase source (a TTY prompt, `--passphrase-file`, an environment variable), and that is a
   design question, not a defect.
3. **It needs machinery built from scratch:** an I/O seam, a no-echo prompt, and tests that work
   without a pty.
4. **After this phase, encryption has a sound place to land.** It can slot into a write path and
   sign-side checks that are already right, and Phase 16 can start from a written design.

---

## Objective

Make `keygen` write a key file with the intended mode, without following a symlink and without
risking the old key, `--force` included. Make `sign` refuse a key inside the package it signs,
and refuse a key file whose two halves do not match, before writing anything. Make the bridge
header maps and the host's `?trust=` lookup read own properties only. Normalize line endings in
the repository so a checkout cannot break a committed hash. Bring the living documentation up to
date.

## Invariants this phase must preserve

1. No change to the signature format, the payload, `KEY_FILE_VERSION` (still 1),
   `openmini.sig.json`, the runtime verification path, or trust configuration. The only runtime
   change is W4's two map constructors in `network.ts`, and the only host change is W5's lookup
   gate. No refusal code or error message changes.
2. Existing key files keep signing. An honest keygen → sign → verify run is byte-compatible with
   today's.
3. Without `--force`, `keygen` still refuses an existing path through the open itself.
4. Every existing unit test and all 59 browser specs pass **unmodified**.

## Non-goals

Stated so they cannot drift in:

- **No encrypted keys.** No passphrase, prompt, environment-variable source, TTY handling or I/O
  seam. That is a Phase 16 candidate, and it needs its own design.
- **No permission check on read.** An ssh-style refusal of a group- or world-readable key is a
  policy change; it is recorded, not made.
- **No Windows ACL handling.** The caveat is documented instead.
- No content sniffing for key files in `verify`, and no `.gitignore` key pattern.
- **No change to `build`'s removal of `outDir`.** It can delete a key kept in `dist/`. That is
  recorded, and W2's refusal discourages that layout.
- **No other carried work:** no T1, no `SandboxOptions.provenance` removal, no quota redesign, no
  storage delete/clear, no SDK timeout change, no CI matrix, no release work, no `SECURITY.md`.
- No change to Phase 9–14 records.

---

## Work items and commit boundaries

| #   | Commit         | Scope |
| --- | -------------- | ----- |
| P   | `docs`         | This file, recorded before implementation. |
| W1  | `fix(cli)`     | **K1.** [keygen.ts](../../packages/cli/src/commands/keygen.ts). Without `--force`: unchanged, an exclusive open on the target itself. With `--force`: write a sibling temp file with `wx` and `0o600`, then `rename` it over the target. `rename` replaces a symlink at the path rather than following it; the mode comes from the fresh create; the old key survives until the rename. The temp file is removed on any failure. |
| W2  | `fix(cli)`     | **K2.** [sign.ts](../../packages/cli/src/commands/sign.ts). **Reproduce first** through the built binary in the session scratchpad. Then `signPackage` refuses a key file inside the package directory, comparing the `realpath`s of both (both exist at that point), and does so before digesting. A new `SignError` message names the path and the reason. In-process tests in `sign.test.ts`, and a built-binary test in `cli.binary.test.ts`. |
| W3  | `fix(cli)`     | **K3.** `sign.ts`. After `signIntegrityPayload` and **before writing**, verify the envelope against the key file's own SPKI with the existing shared verification. A mismatch is a `SignError` ("privateKey and publicKey in … do not match"), and no `openmini.sig.json` is written. |
| W4  | `fix(runtime)` | **N2.** [network.ts](../../packages/runtime/src/bridge/handlers/network.ts). Build `readParams`' request-header map and `collectResponseHeaders`' response map with `Object.create(null)`, as Phase 14 W1 did. Tests in `network.test.ts`. |
| W5  | `fix(host)`    | **N1.** [trustConfig.ts](../../apps/host/src/miniapp/trustConfig.ts). An `Object.hasOwn` gate in `readTrustConfigSource`. Tests in `trustConfig.test.ts`. |
| W6  | `chore`        | **R1.** Add `.gitattributes` with `* text=auto eol=lf`. |
| W7  | `docs`         | Documentation close-out (see [W7 in detail](#w7-in-detail)). CI for W7's own SHA is marked **pending** in the record, because it cannot exist until W7 is pushed. |
| —   | `docs`         | **CI-record follow-up, not a work item.** Created only after W7 is pushed and CI on W7's exact SHA has completed green. Replaces the pending row with that run and sets the status to closed. Nothing else. |

**Commit boundaries.** One work item per commit; items are never combined. The CLI fixes are
three commits because they are three behaviours with three severities: a `git bisect` landing
between them should still say something true. The runtime and host fixes are separate packages,
so separate commits, as in Phase 14.

**Order.** The substance comes first (W1–W3), then the two own-property fixes. `.gitattributes`
comes last before docs, so every earlier gate runs on the checkout as it has been since Phase 9.

**Cut list, in order:** W6, W5, W4. W1–W3 are the substance and are not cut.

### W1 in detail

- **Production.** The `--force` branch writes `<target>.<random>.tmp` beside the target with
  `flag: 'wx'` and `mode: 0o600`, then `rename`s it over the target. On any error, the temp file
  is removed (best effort) and the error rethrown. The non-`--force` branch, and its `EEXIST` →
  `KeygenError` mapping, are unchanged. The comment at `keygen.ts:65-68` is corrected so that it
  is true of both branches.
- **Tests** (in `sign.test.ts`'s existing `generateKeyFile` describe):

  | Test | Asserts | Platform |
  | --- | --- | --- |
  | `--force` over an existing `0644` file | the result is mode `0600` | POSIX only |
  | `--force` where the path is a symlink to another file | the symlink target is byte-identical afterwards, and the path is now a regular file | POSIX only |
  | `--force` whose write fails | the old key file is byte-identical, and no temp file is left behind | every platform |
  | `--force` over an existing file | a new key, readable by `sign` | every platform |

- **Platform split.** The POSIX-only rows use `it.runIf(process.platform !== 'win32')`. They run
  on every Linux CI push but not in the local Windows gates. That is the reverse of T1's
  asymmetry, and it is recorded rather than hidden.

### W2 in detail

- **Reproduction first.** In the scratchpad, against `packages/cli/dist/cli.js`: keygen with the
  key inside the package directory, sign, verify. The expected result today is `verified`, with
  the key file counted among the covered files. The outputs are recorded.
- **Production.** After the manifest check and the key-file read, and before digesting: resolve
  `realpath(packageDir)` and `realpath(keyFile)`, take `relative()` between them, and refuse
  unless the result escapes. Escaping means `..`, a path starting with `..` plus a separator, or
  an absolute path, which is the same test as `build.ts`'s `resolveOutDir`. Never compare string
  prefixes. Comparing `realpath`s means a symlinked or differently-cased spelling of the same
  location is still caught.
- **Tests:**
  - In-process (`sign.test.ts`):
    - a key at the package root is refused;
    - a key in a nested directory of the package is refused;
    - a key in a sibling directory whose name merely starts with the package's name is
      accepted, the positive control for the prefix pitfall;
    - an ordinary key outside the package is accepted.
  - Built binary (`cli.binary.test.ts`): `sign` exits 1 with the refusal message, and no
    `openmini.sig.json` is written.

### W3 in detail

- **Production.** After `signIntegrityPayload` returns the envelope, verify it against the SPKI
  read from the key file, using the shared verification functions already used by `verify` and
  by the tests. If it does not verify, throw a `SignError` naming the key file, and do not write
  `openmini.sig.json`.
- **Tests** (`sign.test.ts`):
  - a key file whose `publicKey` is replaced with another pair's: `signPackage` rejects with the
    mismatch message, and no signature file exists afterwards;
  - an honest key: unchanged, the positive control.

### W4 in detail

- **Production.** `headers = Object.create(null)` in `readParams`, and the same in
  `collectResponseHeaders`, each with a comment in the house style. The types stay
  `Record<string, string>`.
- **Tests** (`network.test.ts`):
  - a request header named `__proto__` reaches the injected `fetch`;
  - `constructor` still does, the control;
  - blocked headers are still refused before any fetch;
  - a response header named `__proto__` is surfaced, if the existing test harness can produce
    one. If it cannot, that is stated and the response side rests on code review.
- **Fixtures.** Header objects containing `__proto__` are built with `JSON.parse` or with
  `Object.create(null)` and assignment, never an object literal, for the reason Phase 13
  recorded. `fetch` and `Headers` accept a null-prototype record, because they enumerate own
  keys; this is checked, not assumed.

### W5 in detail

- **Production.**
  `Object.hasOwn(TRUST_CONFIG_SOURCES, requested) ? TRUST_CONFIG_SOURCES[requested] : TRUST_CONFIG_SOURCES.default`,
  with a comment.
- **Tests** (`trustConfig.test.ts`):
  - `constructor`, `toString`, `hasOwnProperty`, `valueOf` and `__proto__`, parameterised, each
    return the `default` source as a string;
  - the existing `missing`, `invalid`, URL and `../../etc/passwd` cases are unchanged.

### W6 in detail

- **Change.** Add `.gitattributes` with `* text=auto eol=lf`, and a comment naming R1.
- **Evidence** (no mutation, because there is no logic to mutate):
  1. `git add --renormalize .` stages **nothing**, because every index blob is already LF.
  2. The two CRLF working files are rewritten with `git show HEAD:<file> > <file>`, and
     `git hash-object <file>` equals `git rev-parse HEAD:<file>` for each.
  3. `git ls-files --eol` shows `w/lf` and `attr/text=auto eol=lf` for every file.
  4. hello-remote's inline-script hash recomputes to the committed CSP value.
  5. **Local `pnpm format:check` passes**, for the first time since Phase 9.
- **Phantom ` M`.** If git shows a phantom ` M` on either file after the attribute lands, use the
  Phase 14 procedure: `git add <file>`, then confirm with `git diff --cached --quiet`. Never
  `git checkout` or `git restore`.

### W7 in detail

- **`cli.md`:**
  - the key-file format;
  - `--force` semantics: atomic replacement, the mode, symlinks;
  - the inside-package refusal and the key-pair check;
  - the Windows `0600` caveat;
  - the `init … [--force]` synopsis.
- **`integrity.md`:** the custody notes.
- **`bridge.md`:**
  - the header note for N2;
  - "slightly over the cap" corrected to the measured worst case.
- **The top-level README:** the status line, the phase list and the CLI summary.
- **Titles:** `docs/README.md`'s entries, `cli.md` and `integrity.md`.
- **The ledger**, carried forward: item 10 **closed** (by W4, W5), item 12 **closed** (by W6),
  item 7 still open (encryption, Phase 16 candidate), and T1, T2 and `provenance` recorded.
- **This file**, converted into the phase record.
- **The final local verification.**

---

## Test plan

### Fail-before / pass-after

**Method.** Every mutation is run **after** the fix and its tests are written. The fixed file is
saved to the session scratchpad before mutating, and copied back afterwards. `git hash-object`
must then match the saved copy's hash. Never `git checkout -- <file>` or `git restore`: on this
checkout they write CRLF.

| Mutation | Expected |
| --- | --- |
| W1: the `--force` branch back to a direct `'w'` write | The mode and symlink tests fail (in Linux CI; locally they are skipped), and the failed-write test fails, because the old key is truncated |
| W2: guard removed | The in-process refusal tests fail; after rebuilding `dist/` with the mutation, the binary test fails because `sign` exits 0. Restore, rebuild, and confirm the binary test passes again |
| W3: check removed | The mismatch test fails, and a signature file is written |
| W4: maps back to `{}` | The `__proto__` header test fails; the `constructor` control and the blocked-header tests still pass |
| W5: gate removed | The five prototype-name cases return a non-string; the existing cases pass |

**The W1 mutation's mode and symlink rows cannot be observed locally.** Their failure under the
mutation is therefore argued from the code, not shown. The failed-write row is observable on
every platform, and is the local fail-before evidence. If a POSIX environment becomes available
during implementation, the mutation is run there too. Either way, the record says which of the
two happened.

### Gates

- `pnpm lint`, `pnpm typecheck` and `pnpm build`.
- `pnpm test`: at least 1166, all passing, no pre-existing test modified.
- `pnpm e2e`: 59, all unmodified.
- `pnpm format:check`:
  - **Through W5** it may fail only on the two known CRLF files,
    `apps/host/src/miniapp/fixtures/hello-styled/src/index.html` and
    `packages/runtime/src/bridge/handlers/storageScope.ts`. Check both with `git hash-object`
    against `git rev-parse HEAD:<file>`. Any third file is new and must be explained before
    committing.
  - **From W6 on** it must **pass** locally.

### Manual check with the real CLI

After W3, and repeated at W7 against `packages/cli/dist/cli.js` rebuilt by `pnpm build`, in a
scratchpad outside the repository. Each output is recorded in the phase record.

Cases:

- keygen;
- keygen `--force` over an existing file;
- sign with the key inside the package (root and nested);
- sign with the key outside it;
- sign with a mismatched key pair.

Ordinary controls, which matter as much as the fixed cases: keygen → sign → verify →
`trust validate`, end to end.

---

## Risks

1. **`rename` portability.** On Windows, `fs.rename` replaces an existing file, but fails if the
   target is open elsewhere. The temp file lives in the target's directory, so the rename never
   crosses a filesystem.
2. **`realpath` and case on Windows.** Both paths go through `realpath` and the `relative`, `..`
   and `isAbsolute` escape test, never a string-prefix comparison. The sibling-prefix positive
   control pins the pitfall.
3. **POSIX-only tests are invisible locally.** Mitigated by Linux CI running them on every push,
   and by recording the asymmetry.
4. **Null-prototype header maps** passed to `fetch`. Checked in W4's tests rather than assumed.
5. **`.gitattributes` side effects.** With every blob already LF, the renormalize is expected to
   be empty. If it is not, W6 stops and reports before committing.
6. **Over-claiming.** K2 is misuse the docs already warn against, not a signature bypass, and
   none of N1, N2 or R1 is a security hole. The commit messages say so.

---

## Exit criteria

- `pnpm lint`, `pnpm build`, `pnpm typecheck` pass, and `pnpm format:check` passes locally from
  W6 on.
- Unit tests **at least 1166**, all passing, with no pre-existing test modified.
- Browser e2e **59**, all passing and unmodified.
- Each fix has its fail-before evidence recorded, and W1's platform split is stated.
- W2's reproduction and the manual CLI check are recorded.
- Every invariant has evidence recorded against it.
- Every work item is committed separately, pushed only after explicit approval, and green on
  **its own exact SHA**, both `build` and `e2e`, before the next item starts.
- CI green on **W7's exact SHA**, recorded by the CI-record follow-up.
- The follow-up pushed, and the CI run on **its** exact SHA confirmed green once. That run is
  verified but deliberately not recorded by a further commit.

---

## Execution control

Checkpointed exactly as in Phases 13 and 14. Each **STOP** waits for explicit approval. No
earlier approval, or approval for a different step, carries over.

1. **P.** Create and commit **only** this file, as a `docs` commit. Then **STOP**.
2. **W1 does not start** until it is explicitly approved.
3. **Each of W1–W7:**
   - work on that item only;
   - run its planned mutation evidence and the required local gates;
   - commit that one work item locally;
   - **STOP before pushing.**
4. **A push needs explicit approval.** The plan commit or a work-item commit is pushed only after
   that.
5. **After each push**, check the GitHub Actions run for that **exact SHA** through the public
   REST API.
6. **The next item waits for green CI.** It does not start until both `build` and `e2e` for the
   current exact SHA have **completed successfully**. If either is queued or in progress, report
   and stop. If either fails, report and stop, and nothing is recorded as green.
7. **One work item per commit.** Items are never combined.
8. **No history edits.** Prior Phase 15 commits are not amended, rewritten, squashed, reset or
   rebased.
9. **W7 stops after its local commit**, before push, like every other item.
10. **CI-record follow-up:**
    - created only after W7's exact-SHA CI is green;
    - touches only this file;
    - pushed separately, as its own step;
    - its own CI is checked once and not recorded by another follow-up commit.

Each work item's own steps happen inside its checkpoint. For example, W2's reproduction through
the built binary runs only after W2 is approved.

---

## Carried forward from Phase 14, and where each stands

| # | Item | Phase 15 |
| --- | --- | --- |
| 1 | No authentication of a person | carried, unchanged |
| 2 | No persistence of user identity, no per-user storage | carried, unchanged |
| 3 | No remote trust distribution or registry | carried, unchanged |
| 4 | No expiry or timestamp semantics | carried, unchanged |
| 5 | No trust on first use | carried, unchanged — eighth phase running |
| 6 | Same-origin collisions for unregistered packages | carried, unchanged |
| 7 | Signing-key custody is an unencrypted local file | **this phase hardens it** (W1–W3); encryption **moves to Phase 16** as its leading candidate |
| 8 | Concurrent multi-tab migration | carried, unchanged |
| 9 | Multi-view routing | carried, unchanged |
| 10 | The `Object.prototype` own-property guard | **this phase**: the bridge header maps (W4) and the host `?trust=` lookup (W5) |
| 11 | No release or publishing workflow, no `SECURITY.md`, no CI matrix | carried, unchanged |
| 12 | `.gitattributes` / CRLF normalization | **this phase** (W6) |

Still open from discovery, unchanged: `SandboxOptions.provenance` is dead API, and T1, the
repository's only conditional test, has never executed in CI.

New open item recorded by this plan: T2, `NETWORK_TIMEOUT` unreachable under the SDK's default
timeout.
