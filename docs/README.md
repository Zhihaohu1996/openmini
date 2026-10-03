# OpenMini Docs

- [Manifest (`openmini.json`) — v1 specification](manifest.md)
- [Mini App sandbox — Phase 3](security/sandbox.md)
- [Mini App JS Bridge & Capability API — Phase 4 (+ Phase 5 storage, Phase 7 network, Phase 10 storage scoping, Phase 11 trust lifecycle, Phase 12 user identity)](security/bridge.md)
  — the capability model, and what `user.getProfile()` is: host-supplied,
  session-scoped, provenance-gated data, and not a login system.
- [`@openmini/cli` — packaging toolchain — Phase 8 (+ Phase 9 signing, Phase 11 `trust validate`)](cli.md)
- [Package integrity and identity — Phase 9 (+ Phase 11 trust lifecycle)](security/integrity.md)
  — the signature format, the load-time policy, and `openmini.trust.json`:
  revocation, key rotation, and what a host does when its trust
  configuration is missing or invalid.

Phase records (history, not living documentation):

- [Phase 9 — package integrity and identity](plans/phase-9.md)
- [Phase 10 — verified identity as a storage boundary](plans/phase-10.md)
- [Phase 11 — trust lifecycle: operator-owned trust configuration, revocation and rotation](plans/phase-11.md)
- [Phase 12 — session-scoped user identity](plans/phase-12.md)

This directory will grow to hold the rest of OpenMini's developer documentation
(architecture, SDK reference) as those pieces are built in later phases.
