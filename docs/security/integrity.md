# Package integrity and identity — Phase 9 (+ Phase 11 trust lifecycle, Phase 12 identity gating, Phase 13 own-property lookups)

Phase 9 answers two questions a host could not previously ask about a Mini App package:

1. **Are these the bytes that were published?** — content integrity.
2. **Who published them?** — identity.

They are separate questions with separate answers, and this document keeps them apart
throughout, because most of the design follows from not confusing them.

Phase 11 adds a third, which only has an answer once the first two do:

3. **Does the host still accept the key that signed them?** — the key lifecycle.

Implemented in [`@openmini/shared`](../../packages/shared/src/integrity.ts) (format and
verifier) and [`trustConfig.ts`](../../packages/shared/src/trustConfig.ts) (the trust
configuration format), [`@openmini/cli`](../../packages/cli/src/commands) (`keygen`, `sign`,
`verify`, `trust validate`) and
[`@openmini/runtime`](../../packages/runtime/src/sandbox/packageVerification.ts) (load-time
policy).

## The artifact: `openmini.sig.json`

A **detached** signature file, a sibling of `openmini.json` at the package root:

```json
{
  "sigVersion": 1,
  "algorithm": "ecdsa-p256-sha256",
  "keyId": "8k2K…",
  "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…",
  "payload": "{\"payloadVersion\":1,\"id\":\"com.example.app\",\"version\":\"1.0.0\",\"files\":{…}}",
  "signature": "MEUCIQD…"
}
```

Detached rather than embedded, so a package's own files are never rewritten by signing and
`build` output stays byte-identical whether or not it is later signed.

### The payload is opaque to the signature

`payload` is a **string**. The signature covers the UTF-8 bytes of exactly that string, and the
verifier checks the signature *first*, parsing the payload only afterwards.

The alternative — signing a structure and re-deriving the signed bytes from a parse — requires
producer and consumer to agree on a canonicalization: key order, whitespace, number formatting,
string escapes, and a sort whose collation is identical in Node and in every browser. Each of
those is a way for an honest package to fail verification on somebody else's machine. An opaque
payload removes the category: the bytes that were signed are the bytes that are stored.

It also removes the JSON duplicate-key hazard. `JSON.parse` silently keeps the last of
`{"a":1,"a":2}`, so a verifier that hashes text and then acts on a parse can check one value and
use another. Here the parse happens after the signature is known good.

A consequence worth stating: **reformatting `openmini.sig.json` is harmless.** Indentation and
key order outside `payload` are not covered and do not need to be.

### What the payload binds

`id`, `version`, and a map of package-relative POSIX path → `sha256-<base64>` of that file's
bytes.

Binding `id` and `version` is not decoration. Without them a signature is transplantable: lift a
signature file onto a package claiming a different `id` and the digests still match, because the
files are the same.

`openmini.sig.json` **must not appear in `payload.files`**, and a payload claiming otherwise is
rejected. Its own bytes contain the signature, so its digest cannot be computed before it exists.

`openmini.json` **must** appear. The manifest declares permissions and network domains, so a
signature omitting it would attest to the code while leaving what the code is *allowed to do*
unsigned.

**Every entry the payload lists is kept**, whatever its name. The parsed `files` map is built with
no prototype, so a path such as `__proto__` or `constructor` is an ordinary entry, and a name the
payload does *not* list reads as absent rather than as something inherited from
`Object.prototype`. Before Phase 13 the map was a plain object, and an entry named `__proto__`
was silently dropped from a signed statement. Such names are legal POSIX file names and are not
blocklisted; see [Lookups read own properties only](#lookups-read-own-properties-only-phase-13).

### Algorithm

ECDSA P-256 with SHA-256, as one non-negotiable string. There is no algorithm agility: a
selectable algorithm field is a downgrade surface, and changing any part of this is a
`sigVersion` bump. An unrecognized `sigVersion` is refused rather than best-effort parsed.

Signatures are **raw `r||s`** (64 bytes), which is what WebCrypto expects. OpenSSL emits DER; a
DER-wrapped signature is rejected with a message that says so, because it is the most likely
interop mistake here.

## `keyId` identifies. The key is the trust anchor.

`keyId` is `base64url(sha256(spki))` — a short label for logs, errors and key rotation. **Trust
is never decided on it.** A caller decides trust by comparing the complete SPKI public key
material returned by the verifier against its trust store. Trusting the string would be trusting
an attacker-chosen field; it costs nothing to claim someone else's.

An envelope whose `keyId` disagrees with its own `publicKey` is rejected as malformed. That is a
consistency check to keep misleading identifiers out of logs, not a trust check.

**Verification succeeding does not mean the package is trusted.** Anyone can sign a package with
their own key and produce a perfectly valid envelope. `openmini verify` says so in its own output
and always prints the key.

## Load-time policy

The trust store maps `manifest.id` → the keys allowed to sign it, each holding the complete
base64 SPKI key material. An id present in it is **registered**: the host is asserting it knows
who owns that id, and that assertion is the only thing that makes failing closed possible.
"Present" means an own property of the store. An id that only exists on `Object.prototype` —
`constructor`, `toString`, `__proto__` — is not registered, and `verifyPackage` returns an
outcome for any string id rather than throwing.

The order in
[`packageVerification.ts`](../../packages/runtime/src/sandbox/packageVerification.ts):

1. **A present signature is always checked, and a broken one always fails** — never degraded to
   "unsigned". This is the anti-downgrade property. If a failed signature fell through to the
   unsigned path, tampering with a signature file would be strictly easier than deleting it, and
   every check below would be optional in practice.
2. **The payload must claim the same `id` and `version` as the manifest.**
3. **The manifest's bytes must match its signed digest.**
4. **A registered id fails closed**: unsigned, signed by an unregistered key, or signed by a key
   the host has **revoked** for that id, and it does not load at all.
5. **An unregistered id may load unverified.** The host has expressed no opinion about who owns
   it, so there is nothing to fail closed against.

Every combination, and what it produces:

| Signature | Id registered? | Result |
| --- | --- | --- |
| valid, registered key, `active` | yes | loads, `verified: true` |
| valid, registered key, `revoked` | yes | **refused** (`revoked-key`) |
| valid, other key | no | loads, `verified: false` / `untrusted-key` |
| valid, other key | yes | **refused** (`untrusted-key`) |
| absent | no | loads, `verified: false` / `unsigned` |
| absent | yes | **refused** (`unsigned-registered`) |
| present but invalid | either | **refused** (`signature-invalid`) |

### Refusals are values, not prose

Every refusal carries a `code` alongside its human `reason`
(`PackageRefusalCode`), and `loadMiniAppFromUrl` passes it through to the host. A host has to
render "revoked" differently from "never registered" because the remedies differ, and telling
them apart by matching the message text would make the wording load-bearing. The reason strings
are unchanged from Phase 9; the code is additive.

The code is present when a package was fetched and then refused, and absent for failures that are
not verification outcomes at all — a 404, a timeout, an unparseable manifest. Those are not
refusals and were deliberately not given codes.


## Trust configuration and the key lifecycle (Phase 11)

Phase 9 made the trust store a value the host passed in; in practice the shipped host compiled a
generated TypeScript module into its bundle, so registering an id meant editing source and
rebuilding. Phase 11 makes it a file the operator owns, and gives the keys in it a lifecycle.

### `openmini.trust.json`

A host-operator-owned document, parsed and validated by
[`trustConfig.ts`](../../packages/shared/src/trustConfig.ts) in `@openmini/shared` — deliberately
**not** beside the manifest parser. `openmini.json` is written by the Mini App author and travels
with the package; this file is written by whoever runs the host and is the one input to the load
decision the package cannot influence. They sit on opposite sides of the trust boundary, so they
do not share a package.

```json
{
  "trustConfigVersion": 1,
  "packages": {
    "com.example.app": {
      "keys": [
        { "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…", "status": "active", "keyId": "2026-laptop" },
        { "publicKey": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE…", "status": "revoked" }
      ]
    }
  }
}
```

The rules carry over from `openmini.sig.json`, because the reasoning has not changed:

- **Unknown fields are rejected**, not best-effort parsed. A field this reader drops is a field a
  future reader enforces.
- **An unrecognized `trustConfigVersion` is refused**, not downgraded.
- **`publicKey` is the complete base64 SPKI key material.** `keyId` is an operator-facing label
  so a human can tell two blobs apart; nothing in the decision reads it, on either status.
- **`status` is required and never inferred.** Defaulting an omitted status to `active` would
  mean a key grants trust because a field was forgotten.
- **Every issue is collected, but nothing is registered unless the whole file validates.** There
  is no partial trust configuration.

### Revocation

**Revocation is supported, and a revoked key refuses the load.** It produces `ok: false` with the
`revoked-key` code.

**A revoked key never downgrades to `untrusted-key`, to `unsigned`, or to any unverified path.**
This is the property the phase is built around, and it is not merely cosmetic. `untrusted-key`
refuses a *registered* id, but it is also the identity an *unregistered* id carries while loading
unverified into the shared origin storage tier. A revoked key reported that way would sit one
policy edit away from running, and the operator would have no way to tell a compromised key from
an unknown one. So the refusal happens before the trusted/untrusted question is asked, and
produces no provenance at all — which means no storage scope can be derived from it.

**Registration is the presence of the id, not the presence of a usable key.** An id whose keys
are *all* revoked is still registered, so an unsigned package claiming it still fails closed.
Revoking every key is not a route back to the permissive unregistered path.

**Revocation is per id.** A key revoked for `com.example.a` and active for `com.example.b` is
refused for the first and trusted for the second.

**`revoked` is retained, not deleted.** Removing a compromised key from the list would stop it
signing, but it would also erase the record that it was ever trusted and make the refusal
indistinguishable from one for a key that was never registered — two situations with different
remedies.

### Key rotation

**Rotation with two overlapping valid keys is supported.** Add the successor as `active`, mark
the predecessor `revoked`. During and after that change:

- a package signed by the successor loads verified;
- a package still signed by the predecessor is refused as `revoked-key`, not as `untrusted-key`;
- **the verified storage namespace does not move.**

That last point is the one rotation depends on. The verified namespace is `v1:id:<id>` and is
derived from the **manifest identity, never from the `keyId`**. If it named the signing key,
rotating would strand an app's data — turning routine key hygiene into a data-loss event, which
is how you get operators who never rotate. Phase 11 did not change that derivation; it proved the
property holds, in unit tests and in a real browser against real IndexedDB.

### What revocation does to data

**Revoking a key makes a package's verified-tier data unreachable. It does not delete it.** There
is no `delete` and no `clear` on `MiniAppStorageProvider`, and Phase 11 adds neither: the load is
refused, so nothing can read the namespace, and the bytes stay where they are. Re-registering the
id — rotating forward to a new active key — restores access, precisely because the namespace
named the id all along.

Migration is unaffected: a revoked id is never selected as an adoption source, because the load
that would have adopted anything never happens.

### Legacy trust entries

`PackageTrustStore` widened from `Readonly<Record<string, readonly string[]>>` to accept a
`string | TrustedKeyEntry` **per element**. A bare string still means exactly what it meant
before Phase 11 — a key that may sign — and normalizes to `{ publicKey, status: 'active' }`.

This was additive and changed no existing behaviour: the widening (W2) and the behavioural flip
(W3) are separate commits, every pre-existing refusal message is byte-for-byte unchanged, and the
Phase 9 verification tests passed unmodified through the widening. A host part-way through
rewriting its configuration — some entries bare strings, some keyed — is a supported state, and a
regression test pins both spellings working side by side in one entry.

Note the deliberate asymmetry with the config *file*, where an omitted `status` is rejected rather
than defaulted. There the operator is writing a lifecycle document and silence is ambiguous; in
the legacy store the absence of the field is the absence of the concept.

**Phase 11 does not set a transition point.** The bare-string form is supported, not merely
tolerated, and when it is deprecated or removed belongs to whichever later phase first has a
reason to force it.

### The host reads the file, and fails closed without it

The host fetches `openmini.trust.json` at startup, validates it with the same parser and renders
issues with the same formatter `openmini trust validate` uses, so the two say the same thing about
the same file.

**If the configuration is missing or invalid, the host refuses the URL-loaded Mini App path
entirely and says why. It does not fall back to an empty trust store.** This is the one place
where "fail closed" needs stating carefully. An empty store registers no ids, so *nothing* fails
closed, and an impostor of a registered id would load as merely unverified — fail-open wearing
the word "empty", and worse than having no trust configured at all, because the operator believes
it is configured. There is deliberately no empty-store fallback anywhere in the API for a caller
to reach for.
### Digests are enforced on every read, not only at load

`FetchResourceProvider` checks each resource's bytes against its signed digest, and **refuses a
file the signature does not mention before fetching it** — for every file name, including names
that exist on `Object.prototype`. Without that, an attacker adds a file rather than altering one
and every digest still matches.

Enforcement applies to `untrusted-key` packages too: a package internally consistent with its own
signature has content integrity even though it has no trusted identity.

Digests always cover the bytes that were *served*, never a re-encoding of decoded text — invalid
UTF-8 decodes to U+FFFD, so distinct byte sequences share one string form. This is why
`boundedFetch` grew an opt-in `captureBytes`.

### Lookups read own properties only (Phase 13)

A bare index into a plain object also reaches everything on `Object.prototype`, so a lookup for
`constructor` answers a function instead of `undefined`. Each lookup that decides what a package
is, or what it may fetch, reads own properties only:

| Lookup | How | What an inherited name would otherwise have done |
| --- | --- | --- |
| The signed payload's `files` map ([integrity.ts](../../packages/shared/src/integrity.ts)) | built with `Object.create(null)` | an entry named `__proto__` silently dropped from a signed statement |
| The provider's digest table ([fetchResourceProvider.ts](../../packages/runtime/src/sandbox/fetchResourceProvider.ts)) | `Object.hasOwn` gate | a file the signature never mentions **fetched** before being refused, and refused with the wrong reason |
| The trust store ([packageVerification.ts](../../packages/runtime/src/sandbox/packageVerification.ts)) | `Object.hasOwn` gate | an id the host never named treated as registered, or a `TypeError` out of `verifyPackage` |

These follow hardening that already existed elsewhere: the trust configuration's `packages` map
and `trustStoreFromConfig` are built with null prototypes, and the bridge dispatcher and
`capabilities.ts` gate their lookups with `Object.hasOwn`.

**None of these was a signature bypass.** Before Phase 13 the digest comparison still failed
closed whenever an inherited value reached it, so nothing was ever accepted that the signature
did not cover. What the fixes restore is that a signed entry is never discarded, that an
uncovered file is never *requested*, and that `verifyPackage` always returns an outcome.

The two fixes on the resource path protect different inputs. On the normal load path,
`verifyPackage` builds the digest table and hands it to the provider, and the table's null
prototype alone keeps inherited names out. The provider's own gate is what protects a table a
caller passes to `createFetchResourceProvider` directly, such as a plain object literal, and the
provider does not rely on the verifier having built its table.

**There is no name blocklist.** `__proto__` and `constructor` remain legal file names and legal
manifest entries, and a package that honestly signs such a file loads. Fixing the lookup fixes it
for every name; a blocklist fixes the names someone remembered.

Not yet covered: `openmini verify` builds its map of on-disk digests as a plain object, so a
signed path named `constructor` that is missing from disk is reported as `modified` instead of
`missing`. Verification still fails; only the reason is wrong.

## Result shape

`loadMiniAppFromUrl` returns a `PackageProvenance`, threaded through `SandboxOptions`,
`BridgeDispatcherOptions`, `BridgeHandlerContext` and into the host UI:

```ts
type PackageProvenance = {
  readonly baseUrl: string;
  readonly identity:
    | { readonly verified: true; readonly id: string; readonly keyId: string }
    | { readonly verified: false; readonly reason: 'unsigned' | 'untrusted-key' };
};
```

It is **optional** below the loader, and `undefined` is a distinct state, not a default to fill
in. `undefined` means no package load happened — a static fixture, or a test. `verified: false`
means a package was loaded and failed to establish a trusted identity. Collapsing them would let
a fixture read as a package that failed its check.

## CLI

```
openmini keygen --out <keyfile> [--force]
openmini sign [dir] --key <keyfile>
openmini verify [dir]
openmini trust validate [dir|openmini.trust.json]
```

See [cli.md](../cli.md) for the full command reference.

`trust validate` runs the same parser and prints the same issue text the host runs, so a
configuration it accepts is one the host accepts. Like `verify`, it checks the shape of a file
and not whether the keys in it are the right ones: a configuration listing an attacker's key
validates exactly as a correct one does. Only the operator knows which key belongs to which
publisher.

`build` remains deterministic and **unsigned**. ECDSA is randomized, so a build that signed its
own output could never be byte-reproducible. Keeping them separate means anyone can rebuild a
package and compare it byte for byte, with the signature layered on top.

Signing refuses a package containing a **symlink**. A signature must cover bytes the package
actually ships; a link's target may sit outside the package and may change after signing.
Skipping links instead would silently drop a file the author put there.

**The key file is not encrypted.** Wrapping it needs a KDF, a prompt, and a decision about
non-interactive CI, none of which this phase makes. It is written `0600`, and `keygen` says so in
its output. Keep it out of your package directory and out of version control.

## What this is still not

Phase 11 narrowed the first of these rather than removing it. The rest stand unchanged.

- **Key distribution.** *Narrowed, not closed.* Revocation and rotation now exist as an explicit
  lifecycle in a file the operator owns, and a compromised key is retired by marking it `revoked`
  rather than by deleting it from source. What does **not** exist is any way to learn about that
  from anywhere else: no registry, no remote trust distribution, no revocation list fetched over
  the network, no CRL, no OCSP, no transparency log, no key discovery, and no PKI of any kind.
  The trust configuration is a local file, and each host operator maintains their own. Revoking a
  key affects the hosts whose file you edit and no others.
- **Signature expiry or timestamping.** A valid signature is valid forever. `expires` is not an
  ignored field — unknown fields are rejected in both `openmini.sig.json` and
  `openmini.trust.json` — but nor is it a supported one, and `status` has exactly two values with
  no validity window.

  This is deferred rather than overlooked, and the reason is worth stating. An expiry would make
  the load outcome depend on the **host's clock**: a clock that is wrong, or deliberately rolled
  back, would re-admit a key the operator retired, so the mechanism would be weakest exactly when
  it mattered. Expiry also cannot establish *when* something was signed. Without a trusted
  timestamp or some other freshness authority, an attacker simply keeps serving a package that
  was signed before the deadline, and the deadline proves nothing about signing time. Adding
  `expires` would additionally need a payload-format bump. A revocation an operator writes down
  needs none of that, which is why Phase 11 shipped revocation and not expiry.
- **Trust on first use, or any automatic trust.** An unregistered id is never promoted to
  verified, and nothing a package presents can register it.
- **Verified identity for unregistered ids.** An unregistered id never loads as verified, whatever
  it is signed with. Phase 10 does give such packages *storage* isolation by origin — see below —
  but that is separation, not identity: it says two packages are different, never who either one
  is. There is no global package identity: an id means what a given host's configuration says it
  means, and nothing more.
- **Authentication of a person.** *Narrowed, not closed.* Phase 12 gave `user.getProfile()`
  real behaviour — a host-supplied profile, relayed only to a verified package — so it is no
  longer a stub. What does **not** exist is any way to establish who a person is: no sign-in, no
  credential, no token, no session, no account, no identity provider, and no protocol by which
  this runtime could determine identity rather than relay it. A host passes through what it
  already knows, or passes nothing.

  **Signing a package authenticates the publisher, never the user.** Those are different claims
  about different parties, and the phases are stacked rather than merged: verification says which
  publisher's key signed this code, and the Phase 12 gate uses that answer to decide whether the
  code is trusted enough to be *told* something the host already knew. A valid signature says
  nothing whatever about the person at the keyboard.

  Nothing about a user is persisted, and nothing in `openmini.trust.json` describes a person —
  it names signing keys. See [bridge.md](bridge.md#session-scoped-user-identity-phase-12).
- **Encrypted signing-key custody.** The private key stays an unencrypted local file, written
  `0600`. Custody is the operator's; there is no agent, no HSM, and no keychain integration.

## What verification buys in storage (Phase 10)

This document's Phase 9 edition recorded that `openmini.storage.*` scoped keys to a
self-asserted `manifest.id`, and that verification narrowed the resulting collision without
closing it. Phase 10 closed most of it, by making the provenance this phase produces decide the
storage namespace:

| Provenance | Namespace |
|---|---|
| `verified: true` | `v1:id:<id>` — reachable only by a package signed with a registered key |
| `verified: false` | `v1:origin:<origin>\|<id>` — qualified by where it was served from |
| `undefined` (static fixture) | the bare `<id>`, unchanged |

**Still open:** two *unsigned* packages served from the **same origin** that both claim one id
share a store. Pinned by
[`storageIdCollision.test.ts`](../../packages/runtime/src/bridge/storageIdCollision.test.ts).
This is deliberately a different thing from verified identity and remains so: the origin tier
separates packages without identifying them, and registering an id — or serving from distinct
origins — is what closes it.

**Phase 12 added a second consumer of the same answer.** Verified provenance now decides two
things rather than one: which storage namespace a package reaches (Phase 10) and whether it is
told who is using the host (Phase 12). Both read `identity.verified` from the provenance this
document's load-time policy produces, and neither re-derives it. That is the intended shape — the
verification decision is made once, in one place, and consumed by the capabilities that depend on
it. It is also why the verified/unverified distinction is load-bearing rather than advisory: two
capability surfaces now turn on it.

What Phase 12 did **not** change: no storage, no namespace derivation, no migration, no refusal
code, and no load outcome. A revoked package never reaches the user handler for the same reason
it reaches no storage scope — the load is refused and no provenance exists.

**Phase 11 changed nothing here.** The namespace is still derived from the manifest identity,
never from the `keyId`, which is exactly what lets a key rotate without moving an app's data. A
revoked key makes the verified namespace unreachable while it is the only key — the load is
refused, so nothing can read it — but the bytes are not deleted and rotating forward restores
access.

**Signing does not attest inherited data.** A package that becomes verified can carry its
previous storage forward, and that migration confers no attestation on the bytes it copies — a
signature attests the package, never the data the package inherits. Adoption from the bare-id
namespace additionally requires an explicit per-id host opt-in, because those bytes were
writable by any package at any origin.

The normative rules, the migration protocol and the residual limitation live in
[bridge.md](bridge.md#persistent-storage-phase-5); this section records only what package
verification contributes to them.
