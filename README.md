# OpenMini

OpenMini is an open-source, developer-first runtime for secure mini
applications. It is inspired by mature mini-app ecosystems, but designed from
the ground up to be platform-neutral and self-hosted, so any developer or
organization can run it without depending on a single vendor.

## Core principles

- **Open source** — the entire runtime, SDK, and tooling are open and
  auditable.
- **Self-hosted first** — OpenMini runs on your own infrastructure; there is
  no required hosted backend.
- **No required paid third-party APIs** — the platform works out of the box
  without paid external services.
- **Platform neutral** — not tied to any specific cloud provider, app store,
  or proprietary ecosystem.
- **Secure, capability-based mini-app architecture** — mini-apps run inside a
  controlled sandbox and only gain access to host capabilities they are
  explicitly granted.
- **Excellent developer experience** — a modern TypeScript toolchain, fast
  local iteration, and clear APIs.

## Status

**Phase 12: session-scoped user identity.** The project now has a working
end-to-end path from source to a verified, sandboxed Mini App whose data is
scoped to the identity it proved, whose signing key the host operator can
retire and rotate without losing that data, and which is told who is using
the host only once it has proved that identity:

- **Phase 2** — the [`openmini.json` manifest format](docs/manifest.md),
  parsed and validated by `@openmini/manifest`.
- **Phase 3** — the [sandbox boundary](docs/security/sandbox.md): an
  `allow-scripts`-only iframe with a deny-by-default CSP, and a
  `MessageChannel` handshake.
- **Phase 4/5** — the [JS bridge and capability API](docs/security/bridge.md)
  (`storage`, `navigation`, `user`), with persistent, quota-enforced storage.
- **Phase 6** — loading a Mini App package from a URL.
- **Phase 7** — host-mediated network access with a manifest-declared domain
  allowlist.
- **Phase 8** — [`@openmini/cli`](docs/cli.md): scaffold, validate, build and
  serve Mini App packages.
- **Phase 9** — [package integrity and identity](docs/security/integrity.md):
  a detached `openmini.sig.json` (ECDSA P-256), `keygen`/`sign`/`verify` CLI
  commands, and load-time verification against a host trust store that fails
  closed for registered ids.
- **Phase 10** — [storage scoped by package provenance](docs/security/bridge.md):
  a verified package's data lives under its identity, an unverified
  package's under the origin it was served from, with a crash-safe migration
  for packages that become verified.
- **Phase 11** — [operator-owned trust configuration](docs/security/integrity.md):
  an `openmini.trust.json` the host reads at startup instead of a module
  compiled into its bundle, with an explicit `active`/`revoked` key
  lifecycle, key rotation that keeps an app's storage, an
  `openmini trust validate` CLI command, and browser-level evidence for the
  whole lifecycle.
- **Phase 12** — [session-scoped user identity](docs/security/bridge.md#session-scoped-user-identity-phase-12):
  `user.getProfile()` stops being a stub and starts being gated. The host
  supplies a profile it already has; a package receives it only if it both
  declared the `user` permission and proved a verified identity.

What Phases 11 and 12 claim, precisely:

- **Revocation is supported.** A key marked `revoked` for an id refuses the
  load, with its own refusal code.
- **Key rotation with two overlapping valid keys is supported** — a
  successor `active` alongside the predecessor `revoked`.
- **A revoked key never downgrades to `untrusted-key`**, to `unsigned`, or to
  any unverified path.
- **Verified storage stays keyed by manifest identity, not by `keyId`**, so
  rotating a key does not move an app's data.
- **Revocation can make verified data temporarily unreachable; it never
  deletes it.** Re-registering the id restores access.
- **A missing or invalid trust configuration disables the URL-loaded Mini App
  path** and says why, rather than falling back to an empty trust store —
  which would register nothing, so nothing would fail closed.
- **A verified package with the `user` permission** receives the
  host-supplied profile.
- **A verified package without the `user` permission** is refused with
  `PERMISSION_DENIED` — the permission gate and the provenance gate are
  independent, and a refusal is not an anonymous profile.
- **An unverified package, or one with no provenance at all**, receives an
  anonymous profile. Every reason for withholding is indistinguishable to
  the Mini App.
- **A revoked package never reaches the handler**, because the load is
  refused and no provenance exists.
- **No user identity is persisted**, and `sandbox.destroy()` ends its
  lifetime completely.

**`user.getProfile()` is host-supplied, session-scoped, provenance-gated
capability data — not a login system.** There is no sign-in, no credential,
no token, no account and no identity provider anywhere in this runtime, and
Phase 12 adds none. The host passes through what it already knows, or passes
nothing. **Nothing about a user is persisted:** the profile lives for the
lifetime of the sandbox, so `sandbox.destroy()` is a complete sign-out
because there is nothing to delete. The demo host here supplies a fixed
synthetic placeholder and authenticates nobody.

Still to come, and deliberately not provided: **no remote trust distribution
or registry** of any kind (no CRL, no OCSP, no transparency log, no PKI) —
the trust configuration is a local file each operator maintains; **no expiry
or timestamp semantics**, because without a trusted timestamp authority an
expiry would depend on the host's clock and could not establish when
something was actually signed; **no trust on first use**; **no
authentication of a person** — Phase 12 relays an identity the host already
has and never establishes one, so there is still no sign-in, credential,
token, account or identity provider; **no per-user storage partition**;
**no multi-view routing** — `navigation.close()` remains the whole of the
navigation surface, with no manifest vocabulary for more than one `entry`;
**local-file signing-key custody**, unencrypted at `0600`; and no
release/publishing workflow. Two **unsigned** packages served from the
**same origin** that claim one id still share storage — intentionally a
different thing from verified identity. See
[docs/security/integrity.md](docs/security/integrity.md) and
[docs/security/bridge.md](docs/security/bridge.md) for the boundaries the
current phases deliberately do **not** provide.

## Repository layout

```
apps/
  host/           the OpenMini host application (React + Vite + TypeScript)
packages/
  runtime/        @openmini/runtime — sandbox, lifecycle, bridge dispatcher
  sdk/            @openmini/sdk — mini-app-facing SDK
  cli/            @openmini/cli — scaffold/validate/build/serve packages
  ui/             @openmini/ui — shared React UI components
  shared/         @openmini/shared — shared types and utilities
  manifest/       @openmini/manifest — openmini.json manifest parser/validator
docs/             developer documentation — see manifest.md for the v1 manifest spec
examples/         minimal-manifest/ — a static example openmini.json
```

## Getting started

Requires [Node.js](https://nodejs.org/) 24+ (the version in `.nvmrc`, which CI uses) and
[pnpm](https://pnpm.io/).

```bash
pnpm install     # install all workspace dependencies
pnpm dev         # start the host app's dev server
pnpm build       # build every package and app
pnpm test        # run unit tests across the workspace
pnpm lint        # lint the whole workspace
pnpm format      # format the whole workspace with Prettier
```

## Tech stack

TypeScript, React, Vite, Node.js, pnpm workspaces, Vitest, Playwright,
ESLint, and Prettier.

## License

Apache License 2.0 — see [LICENSE](LICENSE).
