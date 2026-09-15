# Mini App JS Bridge & Capability API — Phase 4

Phase 4 layers a small, deny-by-default RPC protocol on top of the Phase 3
[sandbox boundary and handshake](sandbox.md), giving a Mini App a real (if
intentionally tiny) way to call the host: `openmini.storage.*`,
`openmini.navigation.*`, `openmini.user.*`. It introduces no new trust
boundary — all bridge traffic travels over the exact `MessagePort` the Phase 3
handshake already established.

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

All three handler modules are deliberate stubs, not real subsystems:

- `storage.*` is backed by a plain in-memory `Map` scoped to one sandbox
  instance — not persistent, not `localStorage`, not disk.
- `navigation.close()` requests the host to close the Mini App (see the
  ack-confirmed ordering below).
- `user.getProfile()` returns a static stub (`{ id: null, displayName: null
  }`) — no real identity/auth system exists yet.

No bulk/list operations, no events/subscriptions. Broader storage/navigation/
user features are out of scope for Phase 4.

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
- No persistent storage, no real navigation/routing system, no real
  user/auth system — the three stub handlers are exactly enough to prove the
  architecture end-to-end and no more.

## Testing split

- **Pure Vitest — `packages/shared`**: envelope validators/type guards, the
  shared id generator.
- **Pure Vitest — `packages/runtime/src/bridge`**: dispatcher tests against a
  fake `MessagePort` — permission/method checks, malformed/stale-session
  handling, rate limiting, and the full `navigation.close` closing/fallback
  sequence.
- **Pure Vitest — `packages/sdk/src/bridge`**: client tests against a fake
  port — request/response correlation, concurrent in-flight requests,
  timeout and stale-response handling.
- **Vitest/jsdom — `apps/host`**: the fake-iframe-plus-real-`MessageChannel`
  pattern from `createSandbox.test.ts`, extended to prove dispatcher and
  client talk correctly end-to-end, including the real `close-ack` round
  trip and fallback-timer teardown.
- **Playwright/Chromium — `e2e/`**: `bridge-roundtrip`,
  `bridge-permission-denied`, `bridge-forged-message`,
  `bridge-destroy-mid-request`, and `bridge-navigation-close`, run against a
  real bridge-demo fixture that bundles the actual `@openmini/sdk` via
  esbuild (see
  [`apps/host/scripts/build-bridge-demo-fixture.mjs`](../../apps/host/scripts/build-bridge-demo-fixture.mjs))
  rather than hand-rolled duplicate client logic.
