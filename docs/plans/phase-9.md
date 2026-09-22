# Phase 9 — package integrity and identity (completed)

A record of what Phase 9 set out to do, what was decided, and what shipped. Written so that a
later phase does not have to reconstruct any of it from commit archaeology.

For how the delivered system actually works, read
[security/integrity.md](../security/integrity.md) — that is the living document. This one is
history, and is not updated as the code changes.

**Status:** closed out. Pushed as `ca1ded1`, CI run `35790271975` green.

## Goals

Answer two questions a host previously could not ask about a Mini App package:

1. **Are these the bytes that were published?** — content integrity.
2. **Who published them?** — identity.

They are separate questions, and keeping them separate drove most of the design.

Concretely:

- A detached signature format both the Node CLI and the browser runtime understand identically.
- CLI commands to generate a key, sign a built package, and verify one.
- Load-time verification in the runtime, against a host-configured trust store, that **fails
  closed** for package ids the host has registered.
- Enough of a result type threaded through the stack that a host can tell an operator what was
  concluded.

## Non-goals

Explicit, and still true at close-out:

- **No storage or IndexedDB changes.** Gating storage on provenance would orphan the data of
  every currently-unsigned package; it needs a migration story, not a conditional.
- **No key distribution, revocation, expiry, or rotation protocol.** The trust store is a static
  map the host operator edits.
- **No trust on first use.** An unregistered id is never promoted to verified.
- **No change to `build` determinism.** Signing stays a separate step.

## Approved work-item structure

| Item | Scope |
| --- | --- |
| W1 | `@openmini/shared`: isomorphic digest primitives (SHA-256, base64/base64url) on `crypto.subtle` |
| W2 | Provenance plumbing: thread base URL + verification outcome `LoadMiniAppResult` → `SandboxOptions` → `BridgeDispatcherOptions`/`BridgeHandlerContext` → host state → `MiniAppHost`. No format, no crypto, no behaviour change |
| W3 | `boundedFetch`: opt-in `captureBytes`, default path behaviour-compatible, `network.test.ts` unchanged |
| W4 | `@openmini/shared`: detached `openmini.sig.json` + verifier, ECDSA P-256 + SHA-256, signed over an opaque payload |
| W5 | CLI `keygen` / `sign` / `verify`, tested through the built binary |
| W6 | Runtime verification on load: verification order, anti-downgrade, missing-digest rejection |
| W7 | Host trust store, ephemeral-key signed fixtures, visible verification state |
| W8 | `manifest.id` length bound in both validators |
| W9 | Chromium e2e coverage, plus the storage id-collision limitation test as a separate commit |
| W10 | Documentation |
| W11 | **Optional only** — `.gitattributes` / LF normalization. Explicitly not to be pulled forward to paper over the local Windows CRLF `format:check` residue |

## Final design decisions

### The payload is opaque to the signature

`openmini.sig.json` carries `payload` as a **string**. The signature covers the UTF-8 bytes of
exactly that string, and the verifier checks the signature *before* parsing it.

Signing a structure instead would force producer and consumer to agree on a canonicalization —
key order, whitespace, number formatting, string escapes, and a sort whose collation must match
in Node and every browser. Each of those is a way for an honest package to fail verification on
somebody else's machine. An opaque payload deletes the category.

It also disposes of JSON duplicate keys: `JSON.parse` silently keeps the last of `{"a":1,"a":2}`,
so a verifier that hashes text and then acts on a parse can check one value and use another.
Here the parse happens only after the signature is known good.

Consequence: reformatting `openmini.sig.json` is harmless.

### `keyId` identifies; the key material is the trust anchor

`keyId` is `base64url(sha256(spki))` — a label for logs, errors and rotation. Trust is decided by
comparing the **complete SPKI public key** against the trust store. Trusting the string would be
trusting an attacker-chosen field.

An envelope whose `keyId` disagrees with its own `publicKey` is rejected as malformed — a
consistency check, not a trust check.

### Verification succeeding ≠ trusted

Anyone can sign a package with their own key and produce a valid envelope. `openmini verify`
says so in its own output and always prints the key. Only a trust store can reject it.

### What the signature binds

`id`, `version`, and a map of package-relative POSIX path → `sha256-<base64>`.

- `id`/`version` are bound so a signature is not transplantable onto a package claiming a
  different identity.
- `openmini.sig.json` **must not** appear in its own file map — its bytes contain the signature,
  so its digest cannot exist before it does. Enforced on both sides: the producer skips it at the
  walk, the verifier rejects a payload that lists it.
- `openmini.json` **must** appear. It declares permissions and network domains, so a signature
  omitting it would attest to the code while leaving what the code may *do* unsigned.

### No algorithm agility

ECDSA P-256 + SHA-256, as one non-negotiable string. A selectable algorithm field is a downgrade
surface; changing any part is a `sigVersion` bump. Unknown fields and unrecognized versions are
rejected rather than best-effort parsed. Signatures are raw `r||s`; DER is rejected with a
message naming the mistake.

### Load-time order, and why each step exists

1. **A present signature is always checked, and a broken one always fails** — never degraded to
   "unsigned". This is the anti-downgrade property: otherwise tampering with a signature file
   would be strictly easier than deleting it, and every check below becomes optional.
2. The payload must claim the same `id` and `version` as the manifest.
3. The manifest's bytes must match its signed digest.
4. **A registered id fails closed** — unsigned, or signed by an unregistered key, and it does not
   load. Otherwise registration is decorative.
5. An unregistered id may load unverified. The host has no opinion about who owns it.

### Digests enforced on every read

A file the signature does not mention is refused **before** it is fetched — otherwise an attacker
adds a file rather than altering one and every digest still matches. Enforcement applies to
`untrusted-key` packages too: content integrity and identity are different claims.

### `undefined` provenance is a real state

`PackageProvenance` is optional below the loader. `undefined` means no package load happened (a
static fixture, a test); `verified: false` means a package loaded and failed to establish trusted
identity. No synthetic default is ever filled in — collapsing them would let a fixture read as a
package that failed its check.

### Ephemeral fixture keys

The signed e2e fixtures are signed at build time by a **fresh P-256 pair per run**, used
in-memory and never written to disk. Only the public half reaches the generated (gitignored)
trust config. A committed key would be a published private key that signs packages a real host
trusts, and "it's only for tests" survives exactly as long as it takes somebody to copy the
pattern.

### `build` stays deterministic and unsigned

ECDSA is randomized, so a build that signed its own output could never be byte-reproducible.
Keeping signing separate means anyone can rebuild a package and compare it byte for byte, with
the signature layered on top.

## Completed commit sequence

Base: `a3a8119` (pre-Phase-9 `origin/main`).

| Commit | Item | Summary |
| --- | --- | --- |
| `e3524f6` | W1 | isomorphic digest primitives |
| `4fc913f` | — | **off-plan W2 (superseded)** — see below |
| `1d152b3` | — | **forward revert of `4fc913f`** |
| `a4c8cdb` | W2 | thread package provenance through the load path |
| `3a90473` | W3 | opt-in byte capture in `boundedFetch` |
| `0a6b38b` | W4 | detached signature format and verifier |
| `aed28e3` | W5 | CLI `keygen`, `sign`, `verify` |
| `81620c6` | W6 | verify on load; fail closed for registered ids |
| `6eb52a3` | W7 | trust store, signed fixtures, visible state |
| `bbcc0b5` | W8 | `manifest.id` length bound in both validators |
| `2f07761` | W9 | Chromium e2e for package verification |
| `b05f2f8` | W9 | storage id-collision limitation test (no storage code touched) |
| `5256ad2` | W10 | integrity docs; narrow the identity limitation |
| `ca1ded1` | — | close-out audit: correct three false claims |

### The off-plan W2 and its revert

`4fc913f` implemented something the approved plan did not ask for: a combined
`openmini.provenance.json` holding both the file map and an **Ed25519** signature. It conflicted
with the approved design on four points, each belonging to a different work item — the artifact
is *detached* `openmini.sig.json`, the algorithm is ECDSA P-256 + SHA-256, the integrity format
belongs in W4, and the signing surface in W5. W2 was specified to make no cryptographic format
decisions at all, and that commit made five.

It was corrected by an **ordinary forward revert** (`1d152b3`), not a reset, amend, or rebase, so
the record stays intact: the commit is in history, the revert explains why it was wrong, and
neither is rewritten. The revert was verified to be an exact inverse (empty diff against
`e3524f6`) before committing. The approved W2 then landed as `a4c8cdb`.

This is recorded rather than tidied away because a future reader finding `4fc913f` in `git log`
should not have to guess why a provenance sidecar format exists and then vanishes.

### The close-out audit

`ca1ded1` fixed three statements that described the code inaccurately — a test title asserting
the opposite of its assertion, a doc table introduced as "four outcomes" with six rows, and an
e2e header claiming its five specs were the load path's five outcomes. No functional defect was
found; no production code was touched. (This repository spent Phase 8.5 W13/W14 on exactly this
class of problem, which is why it was worth a commit rather than a shrug.)

## Final verification

| Gate | Result |
| --- | --- |
| lint | pass |
| `format:check` | pass in CI |
| build | pass |
| typecheck | pass |
| unit tests | **841 pass**, 57 files |
| browser e2e | **28 pass** (Chromium) |

Unit test distribution at close-out: `runtime` 390, `cli` 147, `manifest` 142, `shared` 106,
`sdk` 36, `host` 18, `ui` 2. Baseline at the W1 checkpoint was 736, so Phase 9 added 105.
E2E: 23 pre-existing + 5 new verification specs.

### CI evidence

| | |
| --- | --- |
| Pushed HEAD | `ca1ded1e466c77728a3fc9311e95dbe603cc788b` |
| Push range | `a3a8119..ca1ded1` (14 commits, fast-forward) |
| Run | [`35790271975`](https://github.com/Zhihaohu1996/openmini/actions/runs/35790271975) (run #13, event `push`) |
| Conclusion | **success** — jobs `build` and `e2e` both green |

### The local CRLF `format:check` discrepancy

`prettier --check .` warns locally on Windows for
`apps/host/src/miniapp/fixtures/hello-styled/src/index.html`. This was diagnosed, not
reformatted:

- the working-tree hash equals the committed blob (no local modification);
- the file has CRLF terminators from checkout;
- after stripping CR bytes, prettier passes.

CI runs `format:check` on Linux and it **passes**, confirming the repository is genuinely
format-clean and the warning is a Windows checkout artifact. W11 is the fix.

## W11 — remaining, optional, unimplemented

`.gitattributes` / LF normalization was approved as **optional only**, to be done only if
explicitly reached, and explicitly **not** to be pulled forward to silence the CRLF residue
above. It was not implemented: no `.gitattributes` exists and no eol or `.editorconfig` change
was made.

## Limitations carried into future phases

Recorded normatively in [security/integrity.md](../security/integrity.md) and
[security/bridge.md](../security/bridge.md):

1. **No key distribution or revocation.** Static trust map, edited by hand. No registry, expiry,
   revocation list, or rotation protocol.
2. **No signature expiry or timestamping.** A valid signature is valid forever. `expires` is
   rejected as an unknown field rather than honoured.
3. **No trust on first use.**
4. **`manifest.id` is still not a boundary for *unregistered* ids.** Narrowed, not closed: a
   registered id is genuinely owned, but two unsigned packages sharing an unregistered id still
   share storage. Pinned by
   [`storageIdCollision.test.ts`](../../packages/runtime/src/bridge/storageIdCollision.test.ts)
   so that closing it later breaks a test naming what changed.
5. **The signing key file is unencrypted.** Written `0600` with an exclusive open; wrapping it
   needs a KDF, a passphrase prompt, and an answer for non-interactive CI.
6. **Own-property hygiene (observation, not a defect).** `packageVerification` and the digest map
   index plain objects by id/path. The `Object.prototype` key case is unreachable via
   `loadMiniAppFromUrl` (`ID_PATTERN` requires a dot) and fails closed in the resource path
   regardless — but Phase 8.5 R3 hardened the bridge registry against the same class, so a guard
   would be reasonable hygiene.
7. **Pre-existing, unrelated to this phase:** `--out` symlink escape in `build`; font and worker
   constructs not detected at build time.
