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

**Phase 2: Mini App manifest system.** Phase 1 delivered the monorepo scaffold
(package layout, build tooling, linting, and test wiring). Phase 2 adds the
first real developer-facing contract: the [`openmini.json` manifest
format](docs/manifest.md), parsed and validated by `@openmini/manifest`. The
mini-app runtime, sandbox, permission enforcement, SDK APIs, and CLI commands
have not been implemented yet; they will land in later phases.

## Repository layout

```
apps/
  host/           the OpenMini host application (React + Vite + TypeScript)
packages/
  runtime/        @openmini/runtime — mini-app runtime (stub)
  sdk/            @openmini/sdk — mini-app-facing SDK (stub)
  cli/            @openmini/cli — command-line tooling (stub)
  ui/             @openmini/ui — shared React UI components
  shared/         @openmini/shared — shared types and utilities
  manifest/       @openmini/manifest — openmini.json manifest parser/validator
docs/             developer documentation — see manifest.md for the v1 manifest spec
examples/         minimal-manifest/ — a static example openmini.json
```

## Getting started

Requires [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/).

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
