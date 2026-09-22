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

**Phase 9: package integrity and identity.** The project now has a working
end-to-end path from source to a verified, sandboxed Mini App:

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

Still to come: key distribution and revocation, real user/auth/identity, and
multi-view routing. Phase 9 verifies packages but does not distribute keys —
a host operator configures trusted keys by hand — and `manifest.id` remains
a self-asserted value for any id the host has **not** registered. See
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
