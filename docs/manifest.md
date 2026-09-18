# OpenMini Manifest (`openmini.json`) — v1

Every OpenMini Mini App ships an `openmini.json` manifest describing itself to the host before
the runtime ever loads it. This document specifies the **v1** contract
(`schemaVersion: 1`), implemented and validated by the
[`@openmini/manifest`](../packages/manifest) package.

This document covers the manifest format only. It does **not** cover the sandbox, permission
enforcement, the JS bridge, or how a Mini App is actually loaded and run — those are later-phase
concerns.

## Fields

| Field | Type | Required | Constraints |
|---|---|---|---|
| `schemaVersion` | integer | yes | Must be exactly `1`. |
| `id` | string | yes | Lowercase reverse-domain-style identifier. See [Application ID grammar](#application-id-grammar). |
| `name` | string | yes | Non-empty, at most 100 characters. |
| `version` | string | yes | A valid [Semantic Version 2.0.0](https://semver.org) string. |
| `entry` | string | yes | Relative, application-internal path. See [Entry path rules](#entry-path-rules). |
| `permissions` | array of string | yes (may be empty) | Each element must be one of `storage`, `navigation`, `user`, `network`. No duplicates. |
| `network` | object | no | Declares the hostnames `network.fetch` may reach. Required in practice by the `network` permission. See [`docs/security/bridge.md`](security/bridge.md). |

Unknown top-level fields are **rejected** in schemaVersion 1 — this is intentionally strict so
the contract can evolve later without ambiguity about what a given manifest author intended.

## Example: a valid manifest

```json
{
  "schemaVersion": 1,
  "id": "com.openmini.restaurant",
  "name": "OpenMini Restaurant Demo",
  "version": "0.1.0",
  "entry": "index.html",
  "permissions": ["storage"]
}
```

A copy of this example lives at
[`examples/minimal-manifest/openmini.json`](../examples/minimal-manifest/openmini.json).

## Application ID grammar

`id` must be a lowercase, reverse-domain-style identifier:

- At least two dot-separated segments.
- Each segment starts with a lowercase ASCII letter (`a`-`z`).
- Subsequent characters in a segment may be lowercase ASCII letters, digits, or hyphens.
- A segment must not end with a hyphen.
- Uppercase characters are invalid anywhere in the id.
- Empty segments are invalid (no leading/trailing/consecutive dots).

| | Examples |
|---|---|
| Valid | `com.example.restaurant`, `io.openmini.live-commerce`, `dev.company.booking` |
| Invalid | `com` (only one segment), `COM.example.app` (uppercase), `com..example` (empty segment), `com.example.-app` (segment starts with hyphen), `com.example.app-` (segment ends with hyphen), `com.example.app_` (underscore not allowed) |

This grammar checks **shape only** — it does not verify that the developer actually owns or
controls the identifier's namespace. Ownership/collision handling is a registry concern, out of
scope until a later phase.

## Entry path rules

`entry` must be a relative, application-internal path (e.g. `index.html`). It must **not** be:

- An absolute filesystem path (e.g. `/etc/passwd`, `C:\Windows\x`).
- A URL (e.g. `https://example.com`, `file:///index.html`). A bare `scheme:` with no `//`
  counts — `https:evil.com` and `data:text/html,x` are URLs to the WHATWG parser and resolve
  away from the package, so they are rejected too.
- A root-absolute path (e.g. `/index.html`).
- A path containing traversal (e.g. `../secret.html`, `a/../../b.html`).

Because a bare `scheme:` is rejected, a relative path whose **first segment contains a colon**
(e.g. `my:file.html`) is also rejected. This is an accepted cost: such names are already
unusable on Windows, and the alternative is accepting entry paths that resolve outside the
package they are declared in.

This check validates the **string shape** of `entry` only. It is defense-in-depth, not the
sandbox boundary: the eventual runtime must still canonicalize and re-check the resolved path
against the Mini App's package root when it actually reads `entry` off disk. This layer does not
protect against symlink tricks, case-insensitive-filesystem quirks, or Unicode
confusable/normalization attacks.

## Permissions

`permissions` is an array of strings. In schemaVersion 1, only these values are recognized:

- `storage`
- `navigation`
- `user`
- `network` — also requires a top-level `network` declaration naming the
  hostnames the Mini App may reach; the permission alone grants nothing.

Any other value fails validation. Duplicate entries also fail validation — the error is
reported against the second (repeated) occurrence's array index, so it's clear which entry to
remove.

An empty `permissions` array is valid — it means the Mini App requests no special capabilities.

## Error format

Validation collects **all** applicable issues in one pass, not just the first, and reports them
as:

```
Invalid OpenMini manifest:
- version: must be a valid semantic version
- entry: path traversal is not allowed
- permissions[1]: unknown permission "camera"
```

Each underlying issue is a structured `{ path, code, message }` object
(see [`@openmini/manifest`'s public API](../packages/manifest/src/index.ts)) — the string above
is what `formatManifestIssues()` produces from that structured list, and what
`ManifestValidationError.message` uses as well, so every consumer (CLI, host, future editor
tooling) renders identical error text.

## Editor / JSON Schema support

A hand-authored JSON Schema (draft 2020-12) ships at
[`packages/manifest/schema/openmini.schema.json`](../packages/manifest/schema/openmini.schema.json).
It's a convenience for editor validation (e.g. VS Code's built-in JSON Schema support) and is
checked against the same test fixtures as the real validator — but it is **not** authoritative.
The TypeScript validator in `@openmini/manifest` (`validateManifest`/`parseManifest`) is always
the source of truth; the schema is a best-effort structural approximation (some rules, like
precise path-traversal safety, are only loosely expressible in JSON Schema).

## Versioning policy

The invariant that actually matters, and which v1 holds to absolutely:

> **A manifest that was valid under v1 must remain valid under v1 forever.**

Within that rule, v1 accepts **additive** growth: a new *optional* field, or a new permission
value, may be added without a version bump, because neither can invalidate a manifest that was
already valid. Phase 7 did exactly this, adding the optional `network` declaration and the
`network` permission.

What still requires a **new `schemaVersion`**, with its own separately validated branch:

- making an optional field required, or removing a field;
- tightening or loosening an existing field's rule (a manifest that used to pass would now fail,
  or vice versa);
- changing the meaning of an existing field or permission.

Note the trade-off this accepts: a v1 manifest using a newer optional field is not understood by
an *older* v1 validator. Backward compatibility is guaranteed; forward compatibility is not.
Tooling should therefore treat an unknown-field error from an older validator as "upgrade your
tooling", not "the manifest is wrong".

> **Corrected in Phase 8.** This section previously said that "a new field… requires a new
> `schemaVersion`", which Phase 7's additive `network` field had already contradicted in
> shipped code. The rule above documents what the project actually practices and keeps the
> guarantee that matters.

## A note on implementation approach

`@openmini/manifest` implements v1 validation as handwritten TypeScript (no JSON-Schema-driven
runtime engine like Ajv, no schema library like Zod). This is deliberately a **schemaVersion 1
implementation decision**, not a permanent architectural stance: v1 is small, flat, and fixed
(seven top-level fields, only one of them nested), so hand-written, independently-audited checks are simpler
and carry zero runtime dependencies. If a future schemaVersion introduces meaningfully nested or
polymorphic structure, the project should re-evaluate schema-driven runtime validation (Ajv,
Zod, or another appropriate approach) rather than indefinitely extending hand-rolled
field-by-field checks.
