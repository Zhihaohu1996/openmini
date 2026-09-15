# Mini App JS Bridge & Capability API — Phase 4 (+ Phase 5 persistent storage)

Phase 4 layers a small, deny-by-default RPC protocol on top of the Phase 3
[sandbox boundary and handshake](sandbox.md), giving a Mini App a real (if
intentionally tiny) way to call the host: `openmini.storage.*`,
`openmini.navigation.*`, `openmini.user.*`. It introduces no new trust
boundary — all bridge traffic travels over the exact `MessagePort` the Phase 3
handshake already established. Phase 5 later made `storage.*` a real, durable,
quota-enforced subsystem (see ["Persistent storage.* (Phase 5)"](#persistent-storage-phase-5))
without changing this protocol or trust model.

## Capability model

The manifest's `permissions: ManifestPermission[]` field (`'storage' |
'navigation' | 'user'`, from
[`@openmini/manifest`](../../packages/manifest/src/constants.ts)) maps 1:1 to
a bridge namespace:

| Manifest permission | Bridge namespace | Methods |
|---|---|---|
| `storage` | `storage.*` | `storage.get(key)`, `storage.set(key, value)` |
| `navigation` | `navigation.*` | `navigation.close()` |
| `user` | `user.*` | `user.getProfile()` |

The permitted-namespace set is computed once, at bridge-creation time, from
the manifest already gated by `gateManifest` — no new manifest re-parsing, no
runtime mutation of the permitted set. Every request goes through two ordered
checks in [`dispatcher.ts`](../../packages/runtime/src/bridge/dispatcher.ts):

1. **Namespace check** — is the method's namespace present in the manifest's
   permission set? If not, the dispatcher returns `PERMISSION_DENIED`
   regardless of whether the method name is real, so an unpermitted caller
   can't learn anything about the registry from the error it gets back.
2. **Method check** — within a permitted namespace, is the exact method
   registered? If not, `UNKNOWN_METHOD`.

Unknown methods and permission failures never reach a handler function.

## API surface (intentionally small)

```ts
openmini.storage.get(key: string): Promise<string | null>
openmini.storage.set(key: string, value: string): Promise<void>
openmini.navigation.close(): Promise<void>
openmini.user.getProfile(): Promise<{ id: string | null; displayName: string | null }>
```

`navigation.*` and `user.*` remain deliberate stubs, not real subsystems:

- `navigation.close()` requests the host to close the Mini App (see the
  ack-confirmed ordering below).
- `user.getProfile()` returns a static stub (`{ id: null, displayName: null
  }`) — no real identity/auth system exists yet.

`storage.*` was originally a non-persistent in-memory `Map` in Phase 4; Phase 5
made it a real, durable, quota-enforced subsystem — see
["Persistent storage.* (Phase 5)"](#persistent-storage-phase-5) below.

No bulk/list operations, no events/subscriptions. Broader navigation/user
features remain out of scope.

## Protocol

The bridge reuses the handshake's existing `channel: 'openmini'` and
`version: 1` fields — no second version namespace. `messaging.ts`'s envelope
`type` union grows from `'handshake-init' | 'handshake-ack'` to also include
`'request' | 'response'` (plus the narrow `'close-ack'` below), defined in
[`@openmini/shared`'s `bridge/protocol.ts`](../../packages/shared/src/bridge/protocol.ts):

```ts
interface BridgeRequestEnvelope {
  channel: 'openmini';
  version: 1;
  sessionId: string;
  type: 'request';
  requestId: string;   // fresh per call, client-generated
  method: string;       // e.g. "storage.get"
  params: unknown;      // validated per-method by the dispatcher
}

type BridgeResponseEnvelope =
  | { channel: 'openmini'; version: 1; sessionId: string; type: 'response'; requestId: string; ok: true; result: unknown }
  | { channel: 'openmini'; version: 1; sessionId: string; type: 'response'; requestId: string; ok: false; error: { code: BridgeErrorCode; message: string } };
```

Per-message flow on the host
([`dispatcher.ts`](../../packages/runtime/src/bridge/dispatcher.ts)): validate
envelope shape (drop silently if malformed) → drop if the dispatcher is
`closing`/`destroyed` → check `sessionId` matches the live sandbox instance
(`SESSION_INVALID` if not, since a live client needs to distinguish a wrong
session from a hang) → namespace permission check → method registration check
→ per-method parameter validation (`INVALID_PARAMS`) → in-flight cap check
(`RATE_LIMITED` past 32 concurrent requests per session) → invoke handler
inside a try/catch (any throw becomes a generic `INTERNAL_ERROR`, no
stack/detail leakage) → post the response on the same port.

### Error codes

```ts
type BridgeErrorCode =
  | 'UNKNOWN_METHOD'
  | 'PERMISSION_DENIED'
  | 'INVALID_PARAMS'
  | 'SESSION_INVALID'
  | 'REQUEST_TIMEOUT'   // client-synthesized only; the host never sends this
  | 'RATE_LIMITED'
  | 'STORAGE_QUOTA_EXCEEDED'   // storage.set only — see "Persistent storage.*" below
  | 'INTERNAL_ERROR';
```

Error messages are short, generic, and non-leaking.

## `navigation.close` ordering

Calling `sandbox.destroy()` directly from the `navigation.close` handler is
unsafe: `destroy()` synchronously removes the iframe from the DOM, and a
detached browsing context can stop processing its task queue before the
just-posted success response is delivered into it — the Mini App's own
`navigation.close()` call could incorrectly reject with `REQUEST_TIMEOUT`
instead of resolving. A `setTimeout(..., 0)` deferral is not an adequate fix
either — it's still a race, just a very likely one.

Instead, `navigation.close` gets a narrow, one-off acknowledgement flow, using
a single extra envelope type (`BridgeCloseAckEnvelope`, `type: 'close-ack'`)
that exists solely to support this one method:

1. On accepting a valid, permitted `navigation.close` request, the dispatcher
   sets an internal `closing` flag — checked first in the per-message flow,
   ahead of the session check. From this point it accepts exactly one thing:
   a `close-ack` whose `requestId` matches the pending close request.
   Everything else is dropped silently, the same way a `destroyed` dispatcher
   drops all messages.
2. The dispatcher posts the normal success response and starts a bounded
   fallback timer (2000ms).
3. The Mini App SDK's generic request/response client resolves
   `navigation.close()`'s Promise as usual — it doesn't know this method is
   special. Immediately after, the `navigation.close()` API wrapper itself
   ([`packages/sdk/src/api/navigation.ts`](../../packages/sdk/src/api/navigation.ts))
   posts a `close-ack` echoing the original `requestId`.
4. On receiving a valid, matching `close-ack`, the dispatcher clears the
   fallback timer and calls `sandbox.destroy()` immediately.
5. If no valid `close-ack` arrives before the fallback timer fires, the
   dispatcher calls `sandbox.destroy()` anyway — a broken or malicious client
   can't hold the sandbox open indefinitely.

This is not a general "every RPC gets acknowledged" mechanism — only
`navigation.close` has dispatcher-side `closing` state, and the shared
`close-ack` envelope type exists solely to support this one flow.
`createSandbox.ts`'s `destroy()` itself is unmodified.

## Persistent storage.* (Phase 5)

`storage.*` is built against a pluggable `MiniAppStorageProvider` interface
([`packages/runtime/src/bridge/handlers/storageProvider.ts`](../../packages/runtime/src/bridge/handlers/storageProvider.ts)):

```ts
interface MiniAppStorageProvider {
  get(appId: string, key: string): Promise<string | null>;
  set(appId: string, key: string, value: string): Promise<void>;
  getUsedBytes(appId: string): Promise<number>;
}
```

Two implementations exist: the original non-persistent in-memory `Map`
(`createInMemoryStorageProvider()`, still the default when no provider is
supplied — existing callers of `createStorageHandlers()` are unaffected), and
a real, durable
[`createIndexedDbStorageProvider()`](../../packages/runtime/src/bridge/handlers/indexedDbStorageProvider.ts),
which `apps/host`'s `MiniAppHost` wires in as the default for the real app.
IndexedDB runs in the **host's own trusted origin** — the sandboxed Mini App
iframe never touches it directly (no `allow-same-origin`, unchanged); it only
ever reaches storage through the existing dispatcher RPC path, so this does
not touch or relax the sandbox/CSP boundary at all.

**Scoping:** every read/write is keyed by `manifest.id` alone (not
`id`+`version`), so storage survives a Mini App version upgrade the way
ordinary app storage does. This relies on the same id-ownership trust
assumption `docs/manifest.md` already flags as an open registry concern — not
a new risk this introduces.

### Quota semantics (normative)

Enforced in `storage.ts`, backend-agnostic (identical behavior regardless of
which provider is plugged in):

| Limit | Default | Override |
|---|---|---|
| Per-key | 512 bytes | `createStorageHandlers({ maxKeyBytes })` |
| Per-value | 8,192 bytes (8 KiB) | `createStorageHandlers({ maxValueBytes })` |
| Per-Mini-App total | 524,288 bytes (512 KiB) | `createStorageHandlers({ maxTotalBytesPerApp })` |

- All three limits measure **UTF-8 encoded byte length** (`TextEncoder`),
  never JS string `.length` — a JS string's UTF-16 code-unit count
  under-counts multi-byte characters (emoji, most non-Latin scripts) relative
  to what's actually persisted.
- The per-Mini-App total counts **both key bytes and value bytes** for every
  stored entry — an earlier design counted values only, which left a DoS gap
  where a Mini App could exhaust host storage via unboundedly large keys
  while staying under the value-only quota.
- **Accounting rule:** a brand-new key adds `keyBytes + valueBytes` to the
  app's total. Overwriting an existing key adds only the *value* delta
  (`-oldValueBytes + newValueBytes`) — that key's bytes were already counted
  at its first write, so they are never re-added on subsequent overwrites.
- Any of the three violations rejects the `storage.set` call with
  `STORAGE_QUOTA_EXCEEDED`, leaving previously stored data completely
  unchanged — no partial writes.
- **Known limitation — best-effort, not transactional.** The existing-key
  lookup and the subsequent write are not atomic with respect to concurrent
  `storage.set` calls for the same `manifest.id`; two concurrent calls can
  each pass their own size check and jointly push the real total slightly
  over the cap. No locking, versioning, or transactional redesign was added
  to close this gap — documented here the same way Phase 3/4 documented their
  own limits, rather than silently glossed over.

## Mini App SDK (`@openmini/sdk`)

Two layers, both mini-app-facing:

1. **Handshake client**
   ([`bridge/connect.ts`](../../packages/sdk/src/bridge/connect.ts)) —
   `initOpenMiniBridge()` runs inside the sandboxed document, validates and
   accepts the Phase 3 handshake, and resolves with the captured port and
   `sessionId`. This generalizes the logic Phase 3's `hello-sandbox` fixture
   had to hand-duplicate inline.
2. **Request/response client**
   ([`bridge/client.ts`](../../packages/sdk/src/bridge/client.ts)) —
   Promise-based; each call gets a fresh `requestId`, and resolves/rejects
   when a matching `response` envelope arrives (matched on `requestId` *and*
   `sessionId`). Default timeout is ~10s; a response arriving after timeout is
   treated as stale and ignored, mirroring the host's own late-message
   defense.

`openmini.storage.*` / `navigation.*` / `user.*`
([`packages/sdk/src/api/*.ts`](../../packages/sdk/src/api)) are thin typed
wrappers around the request client with no logic of their own beyond building
`{ method, params }`. `connectOpenMini()`
([`packages/sdk/src/index.ts`](../../packages/sdk/src/index.ts)) ties both
layers together into the single call a Mini App makes.

**Documented limitation:** there is no explicit host→client "bridge is
shutting down" message. In real usage this is moot — destroying the sandbox
removes the iframe, ending the Mini App's JS realm outright — but it means
client-side cleanup-on-destruction is only exercised via the request timeout
path, not a dedicated teardown signal.

## Security boundaries — explicitly NOT provided by Phase 4

- No direct subresource/network access via `fetch`, `XHR`, `WebSocket`,
  `EventSource`, or `sendBeacon` — still blocked by CSP `connect-src 'none'`,
  which Phase 4 leaves untouched. The Phase 3
  [self-navigation limitation](sandbox.md#known-limitation-self-navigation-is-not-fully-prevented)
  is unrelated to `connect-src` and is unchanged by this phase.
- No arbitrary host DOM access — the bridge is a fixed, closed method
  registry, never a generic "run this in the host" channel.
- No filesystem access, no `eval`/`Function`-based dynamic code execution
  anywhere in the dispatcher or client.
- No general/unrestricted `postMessage` — all bridge traffic stays on the one
  port handed off at handshake.
- No Mini-App-driven RPC registration — the method registry is fixed by the
  host at bridge-creation time.
- No real navigation/routing system, no real user/auth system — those two
  stub handlers remain exactly enough to prove the architecture end-to-end
  and no more. (`storage.*` is no longer a stub as of Phase 5 — see
  ["Persistent storage.* (Phase 5)"](#persistent-storage-phase-5).)
- No transactional/locking storage guarantees — quota enforcement is
  best-effort under concurrent writes (see the quota semantics above).

## Testing split

- **Pure Vitest — `packages/shared`**: envelope validators/type guards, the
  shared id generator.
- **Pure Vitest — `packages/runtime/src/bridge`**: dispatcher tests against a
  fake `MessagePort` — permission/method checks, malformed/stale-session
  handling, rate limiting, and the full `navigation.close` closing/fallback
  sequence; storage provider tests (in-memory and, via `fake-indexeddb`,
  IndexedDB) covering isolation and used-bytes accounting; storage handler
  tests covering the full quota model (per-key, per-value, per-app-total,
  UTF-8 byte measurement, overwrite accounting); and a dispatcher-level
  integration test simulating a destroy/recreate cycle against a shared
  IndexedDB-backed provider.
- **Pure Vitest — `packages/sdk/src/bridge`**: client tests against a fake
  port — request/response correlation, concurrent in-flight requests,
  timeout and stale-response handling.
- **Vitest/jsdom — `apps/host`**: the fake-iframe-plus-real-`MessageChannel`
  pattern from `createSandbox.test.ts`, extended to prove dispatcher and
  client talk correctly end-to-end, including the real `close-ack` round
  trip and fallback-timer teardown.
- **Playwright/Chromium — `e2e/`**: `bridge-roundtrip`,
  `bridge-permission-denied`, `bridge-forged-message`,
  `bridge-destroy-mid-request`, `bridge-navigation-close`, and
  `bridge-storage-persistence` (real destroy → reload cycle, proving
  IndexedDB-backed persistence end-to-end), run against a real bridge-demo
  fixture that bundles the actual `@openmini/sdk` via esbuild (see
  [`apps/host/scripts/build-bridge-demo-fixture.mjs`](../../apps/host/scripts/build-bridge-demo-fixture.mjs))
  rather than hand-rolled duplicate client logic.
