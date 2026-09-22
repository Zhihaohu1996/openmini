# `@openmini/cli` — Mini App packaging toolchain (Phase 8, + Phase 9 signing)

A Mini App is loaded as a **single self-contained HTML document** whose CSP
permits exactly one inline script, identified by its `sha256` hash. Producing
one by hand means bundling all your JavaScript, hashing it, and writing a
`<meta>` policy that matches byte-for-byte. The CLI does that, and owns the
policy so it cannot drift from what the runtime enforces.

```
openmini init <dir> --id <app.id> [--name <name>]
openmini validate [dir|manifest.json]
openmini build [dir] [--out <dir>] [--html <path>] [--script <path>]
openmini dev [dir] [--port <n>]
openmini keygen --out <keyfile> [--force]
openmini sign [dir] --key <keyfile>
openmini verify [dir]
```

Every command exits non-zero on failure, so CI can rely on the exit status.

## The authoring project vs. the package

These are deliberately different things:

| | Authoring project | Runtime package |
|---|---|---|
| Contains | `openmini.json`, `package.json`, `src/`, configs, tests | **only** `openmini.json` and the built entry document |
| Produced by | you | `openmini build` |
| Read by the runtime | no | yes |

The runtime reads exactly two files, so the package contains exactly two
files. Nothing from `src/` is shipped.

```
my-app/                 # authoring project
  openmini.json
  package.json
  src/
    index.html
    main.ts
  dist/                 # the package
    openmini.json
    index.html
```

## `openmini init`

```
openmini init <dir> --id <app.id> [--name <name>] [--force]
```

Scaffolds an authoring project whose first `openmini build` succeeds: an HTML
shell with the required empty `<script></script>` placeholder, an inline
`<style>` block rather than a stylesheet link, no CSP `<meta>` (the CLI owns
that), and a `package.json` declaring `@openmini/sdk`. Run your package
manager's install before building.

`--id` is validated with the same rules `openmini validate` applies, before
anything is written, so `init` output always passes `validate`.

**Without `--force`, a conflict leaves the directory byte-for-byte
unchanged.** All four destinations (`openmini.json`, `package.json`,
`src/index.html`, `src/main.ts`) are checked before any of them is created;
if any exists, the command fails listing *every* conflict and writes nothing
— not even the `src/` directory. `--force` overwrites all four.

This is a preflight check, not a transaction: it makes conflict handling
atomic, but a mid-write I/O failure (disk full, permissions) can still leave
a partial scaffold.

The scaffolded entry script handles `connectOpenMini()`'s rejection, so a new
app reports a failed handshake rather than hanging — see
[security/bridge.md](security/bridge.md)'s "Handshake failure".

## `openmini validate`

Runs `@openmini/manifest`'s real validator and prints its issues through the
shared formatter, so the CLI, the host and any future tooling report
identical text. It adds no validation rules of its own.

## `openmini build`

Bundles `src/main.ts` into a single IIFE, inlines it into `src/index.html`,
hashes the script and any inline `<style>`, generates the CSP, and writes the
package. The output entry filename comes from the manifest's `entry`.

### `--out` must stay inside the project

`--out` is resolved **relative to the project directory**, not the working
directory, and must be a strict descendant of it. `openmini build` deletes its
output directory before writing, so an `--out` pointing elsewhere would delete
something you did not nominate — with `--out .`, the project's own sources.

Rejected before any filesystem change: the project root itself, any ancestor,
any sibling or outside path, and any absolute path that resolves outside the
project (including a different Windows drive).

Not caught: an `--out` that is a **symlink** pointing outside the project.
`resolve` does not follow links; this matches the deliberate
no-symlink-resolution stance the runtime's containment module documents.

### The CLI owns the policy

If your HTML already contains a `Content-Security-Policy` `<meta>`, **the
build fails** rather than merging or overwriting. Silently combining two
security policies is the failure mode worth refusing; remove yours.

### Deterministic output

Identical inputs and tool version produce **byte-identical** output. No
timestamps, absolute paths, random ids, or locale-dependent formatting are
written; the manifest is copied through verbatim rather than re-serialized,
and output is written with LF endings so the bytes match across platforms.
This is what makes `openmini sign` meaningful: a digest says nothing if
rebuilding the same source changes bytes. It is also why `build` itself does
not sign — see "Signing" below.

### What the build refuses, and why

The sandbox CSP makes these unusable at load time, so the build rejects them
up front with an explanation instead of shipping a package that renders as a
blank frame:

| Construct | Reason |
|---|---|
| External `<script src>` | `script-src` is one inline hash |
| `<link rel="stylesheet">` | `style-src` allows only the hashed inline block |
| `onclick=` and other handler attributes | `script-src-attr 'none'`; a hash does not lift it |
| `style=` attributes | governed by `style-src-attr`; hashes never apply to attributes, and `'unsafe-hashes'` is not added |
| `eval`, `new Function`, dynamic `import()` | no `'unsafe-eval'`, and an opaque-origin `srcdoc` document has no base URL to resolve an import against |
| `<img>`, `<iframe>`, `<object>`, `<form>`, `<base>` | the corresponding directives are `'none'` |

Styling is supported through a hashed inline `<style>` element. Images and
remote assets remain unavailable in this phase.

Fonts and workers are also unusable — `font-src` and `worker-src` are
`'none'` — but the build does **not** currently detect or reject them, so
they are absent from the table above: there is no `@font-face`/`new Worker()`
check to describe. A package using either builds successfully and then fails
silently at load. Adding those checks is feature work, not a documentation
fix.

## `openmini dev`

Serves a built package for local development, hardened by default rather
than by flag:

- **binds loopback only** (`127.0.0.1`) — never `0.0.0.0`, so running it on
  an untrusted network does not publish your package to the LAN;
- serves **one** package directory;
- rejects path traversal and directory escape using the runtime's own
  `resolveContainedPath`, including percent-encoded and double-encoded forms;
- **never lists a directory**;
- serves only known extensions (`.html`, `.json`) with explicit content
  types, refusing anything else rather than guessing.

`--port` must be an integer in 1–65535; anything else is rejected rather than
coerced.

The URL shape matches what `loadMiniAppFromUrl` expects, so you can paste it
straight into the host's "load by URL" control. There is no watch/rebuild
mode; re-run `openmini build`.

## Exit codes

| Code | When |
|---|---|
| `0` | The command succeeded, or a help/version request was served. |
| `1` | Anything else: an unknown command or flag, a missing or malformed flag value, an invalid manifest, a failed build, or a refused `init`/`--out`. |

Every command returns its own exit code; the top-level catch in `cli.ts` is a
last resort for genuinely unexpected throws, not the mechanism by which
ordinary failures become non-zero.

Two details worth knowing, both previously surprising:

- `--version`/`-v` is honoured **only as the first argument**. It is not
  scanned across the whole command line, so `openmini init app --name -v`
  scaffolds an app named `-v` rather than printing the version.
- `<command> --help` works for every command and exits 0.

`openmini dev` never exits on its own — it holds the process open until
interrupted, so it has no exit code to report.

## Signing (Phase 9)

The CSP hashes above are a **CSP binding mechanism, not integrity
verification**: they tie the inline script and style to the policy *in the
same document*, so anyone editing the script can recompute the hash, rewrite
the `<meta>`, and produce something internally consistent. Answering "who
produced this package, and are these the bytes they produced?" needs a
signature, which is what these three commands add. The format and the
load-time policy are documented in
[security/integrity.md](security/integrity.md).

```
openmini keygen --out <keyfile> [--force]
openmini sign [dir] --key <keyfile>
openmini verify [dir]
```

### `openmini keygen`

Generates an ECDSA P-256 signing key. `--force` overwrites an existing file,
after which the old key is unrecoverable and packages signed with it can no
longer be re-signed; without it, an existing path is an error.

The `publicKey` printed here is what a host operator puts in a trust store.

**The private key in the file is not encrypted.** It is written `0600`, and
created with an exclusive open so refusing to overwrite is enforced by the
open itself rather than by a check another process could slip between. Keep
it out of your package directory and out of version control. Encrypting it
needs a KDF, a passphrase prompt, and an answer for non-interactive CI, none
of which this phase settles.

### `openmini sign`

Writes a detached `openmini.sig.json` beside the package's `openmini.json`,
covering every file in the package except that signature file itself.

- Paths in the signature are package-root-relative and POSIX-shaped on every
  platform, because the browser runtime that verifies them only ever sees
  forward slashes.
- The order is deterministic, so re-signing an unchanged package does not
  churn the artifact.
- **Symlinks are refused.** A signature must cover bytes the package actually
  ships; a link's target may sit outside the package and may change after
  signing. Skipping links instead would silently drop a file you put there.
- The manifest is validated first — the signature binds `id` and `version`,
  so signing a package with an invalid manifest would attest to an identity
  the runtime rejects anyway.

`build` remains deterministic and unsigned, and signing is a separate step
for that reason: ECDSA is randomized, so a build that signed its own output
could never be byte-reproducible. Keeping them apart means anyone can rebuild
a package and compare it byte for byte, with the signature layered on top.

### `openmini verify`

Checks a package against its signature and reports the two possible failures
separately, because the remedies differ:

| Outcome | Meaning |
|---|---|
| `unsigned` | No `openmini.sig.json`. The package makes no claim; nothing is wrong with it. |
| signature invalid | The signature file was altered, or was never genuine. |
| `signature is authentic, but the package does not match it` | The package was modified after signing. Lists each file as `modified`, `missing`, or `unsigned` (present but not covered). |
| `verified` | Every covered file matches, and every file present is covered. |

**`verify` does not decide trust, and says so in its output.** A package
signed with an attacker's own key verifies here exactly as a legitimate one
does — only a host's trust store can reject that, so the `keyId` and public
key are always printed for you to compare.

## What this phase does not provide

The CLI still makes no claim about **key distribution**: there is no
registry, no expiry, no revocation, and no rotation protocol. A host operator
configures trusted keys by hand, and removes a compromised one the same way.
See the "What this phase does not provide" section of
[security/integrity.md](security/integrity.md), and the narrowed storage note
in [security/bridge.md](security/bridge.md).
