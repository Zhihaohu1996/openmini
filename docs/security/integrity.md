# Package integrity and identity — Phase 9

Phase 9 answers two questions a host could not previously ask about a Mini App package:

1. **Are these the bytes that were published?** — content integrity.
2. **Who published them?** — identity.

They are separate questions with separate answers, and this document keeps them apart
throughout, because most of the design follows from not confusing them.

Implemented in [`@openmini/shared`](../../packages/shared/src/integrity.ts) (format and
verifier), [`@openmini/cli`](../../packages/cli/src/commands) (`keygen`, `sign`, `verify`)
and [`@openmini/runtime`](../../packages/runtime/src/sandbox/packageVerification.ts)
(load-time policy).

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

The trust store maps `manifest.id` → the complete base64 SPKI keys allowed to sign it. An id
present in it is **registered**: the host is asserting it knows who owns that id, and that
assertion is the only thing that makes failing closed possible.

The order in
[`packageVerification.ts`](../../packages/runtime/src/sandbox/packageVerification.ts):

1. **A present signature is always checked, and a broken one always fails** — never degraded to
   "unsigned". This is the anti-downgrade property. If a failed signature fell through to the
   unsigned path, tampering with a signature file would be strictly easier than deleting it, and
   every check below would be optional in practice.
2. **The payload must claim the same `id` and `version` as the manifest.**
3. **The manifest's bytes must match its signed digest.**
4. **A registered id fails closed**: unsigned, or signed by an unregistered key, and it does not
   load at all.
5. **An unregistered id may load unverified.** The host has expressed no opinion about who owns
   it, so there is nothing to fail closed against.

Every combination, and what it produces:

| Signature | Id registered? | Result |
| --- | --- | --- |
| valid, registered key | yes | loads, `verified: true` |
| valid, other key | no | loads, `verified: false` / `untrusted-key` |
| valid, other key | yes | **refused** |
| absent | no | loads, `verified: false` / `unsigned` |
| absent | yes | **refused** |
| present but invalid | either | **refused** |

### Digests are enforced on every read, not only at load

`FetchResourceProvider` checks each resource's bytes against its signed digest, and **refuses a
file the signature does not mention before fetching it**. Without that, an attacker adds a file
rather than altering one and every digest still matches.

Enforcement applies to `untrusted-key` packages too: a package internally consistent with its own
signature has content integrity even though it has no trusted identity.

Digests always cover the bytes that were *served*, never a re-encoding of decoded text — invalid
UTF-8 decodes to U+FFFD, so distinct byte sequences share one string form. This is why
`boundedFetch` grew an opt-in `captureBytes`.

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
```

See [cli.md](../cli.md) for the full command reference.

`build` remains deterministic and **unsigned**. ECDSA is randomized, so a build that signed its
own output could never be byte-reproducible. Keeping them separate means anyone can rebuild a
package and compare it byte for byte, with the signature layered on top.

Signing refuses a package containing a **symlink**. A signature must cover bytes the package
actually ships; a link's target may sit outside the package and may change after signing.
Skipping links instead would silently drop a file the author put there.

**The key file is not encrypted.** Wrapping it needs a KDF, a prompt, and a decision about
non-interactive CI, none of which this phase makes. It is written `0600`, and `keygen` says so in
its output. Keep it out of your package directory and out of version control.

## What this phase does not provide

- **Key distribution and revocation.** The trust store is a static map supplied by the host
  operator. There is no registry, no expiry, no revocation list, and no rotation protocol. A
  compromised key is removed by editing the host's configuration.
- **Signature expiry or timestamping.** A valid signature is valid forever. `expires` is not an
  ignored field — unknown fields are rejected — but nor is it a supported one.
- **Trust on first use, or any automatic trust.** An unregistered id is never promoted to
  verified.
- **Protection for unregistered ids.** See below.

## Known limitation: `manifest.id` is still not a boundary for unregistered ids

[bridge.md](bridge.md) records that `openmini.storage.*` scopes keys to `manifest.id` while
nothing verified a package's entitlement to that id. Phase 9 **narrows** this rather than
closing it:

- For a **registered** id, an impostor is now refused at load. It never reaches the bridge, so it
  never reaches that id's storage. The protection is a closed door, not a check inside storage.
- For an **unregistered** id, nothing has changed. Two unsigned packages from different origins
  that both declare `com.example.notes` still share one store.

The storage handler does not consult `ctx.provenance`, deliberately. Gating storage on it would
orphan the data of every currently-unsigned package, so it needs a migration story rather than a
conditional. The gap is pinned by
[`storageIdCollision.test.ts`](../../packages/runtime/src/bridge/storageIdCollision.test.ts), so
that closing it later breaks a test that names what changed.

Until an id is registered, **do not store anything under `openmini.storage.*` whose disclosure to
another loaded package would matter.**
