# Mini App sandbox — Phase 3

Phase 3 establishes the first real security boundary between the trusted OpenMini host and
untrusted Mini App code, implemented in [`@openmini/runtime`](../../packages/runtime/src/sandbox).
It covers the sandbox boundary, the bootstrap handshake, CSP, and resource loading. It does
**not** cover RPC, capability dispatch, or a permission API — those are later-phase concerns that
build on top of the port established here.

## Sandbox boundary

Every Mini App runs inside an `<iframe>` with exactly one sandbox flag:

```html
<iframe sandbox="allow-scripts">
```

`allow-same-origin` is deliberately never added. Mini App content is delivered via `srcdoc`, which
without `allow-same-origin` gives the frame an **opaque origin** — distinct from the host's origin
and from every other sandboxed frame, with no access to the host's DOM, storage, or cookies. No
other sandbox flag (`allow-top-navigation`, `allow-popups`, `allow-forms`, `allow-downloads`,
`allow-modals`, `allow-pointer-lock`, etc.) is granted.

Same-origin hosting of the host application is acceptable in Phase 3 precisely because
`allow-same-origin` is omitted — the opaque origin is what does the isolating, not network/subdomain
separation. A dedicated origin/subdomain for Mini App content remains a future hardening step, not
something Phase 3 depends on.

## Bootstrap handshake

Communication is `MessageChannel`-based. Exactly one `window.postMessage` call is used, to
transfer `port2` into the iframe during bootstrap:

1. The host creates a fresh `MessageChannel` and a fresh `sessionId` per sandbox instance.
2. It calls `iframe.contentWindow.postMessage({ ...envelope, type: 'handshake-init' }, '*', [port2])`
   — targeting the exact `contentWindow` reference for that iframe.
3. The sandboxed document's bootstrap script validates the event (`event.source` matches its own
   `window.parent`, exactly one port was transferred, the envelope is well-formed) before accepting
   `port2`, then removes its temporary `message` listener.
4. It replies on the port with a `handshake-ack` carrying the same `sessionId`.
5. The host validates the ack (envelope shape, `sessionId` match) before moving the sandbox from
   `ready` to `running`.
6. All further communication happens over the port. No further `window.postMessage` calls occur.

### Why `targetOrigin: '*'` is safe here

The sandboxed iframe has an opaque origin, so there is no nameable origin string the host could
target exactly — `'*'` is the only value that works at all for this call. This is a bootstrap
**transport** necessity, not the trust mechanism. Trust instead comes from the combination of:

- targeting this exact `iframe.contentWindow` reference (not a broadcast, not a lookup by origin),
- a fresh `MessageChannel` and `sessionId` per sandbox instance,
- strict envelope validation on both sides (channel, version, type, session id),
- transferring `port2` exactly once, and
- removing the temporary bootstrap listener immediately after acceptance.

No secret or capability travels in the bootstrap payload itself, so an eavesdropper who somehow
observed it would gain nothing actionable.

## Message envelope

```ts
{
  channel: 'openmini',
  version: 1,
  sessionId: string,
  type: 'handshake-init' | 'handshake-ack',
}
```

Malformed, unknown-type, wrong-version, wrong-`channel`, or wrong-`sessionId` messages are rejected
outright (see [`messaging.ts`](../../packages/runtime/src/sandbox/messaging.ts)). Phase 3 defines
only the handshake types — no RPC or capability messages exist yet.

## Content-Security-Policy

The Mini App document ships its own restrictive CSP (via a `<meta http-equiv="Content-Security-Policy">`
tag, since the document is delivered as `srcdoc` rather than over HTTP):

```
default-src 'none'; script-src 'sha256-<hash-of-the-exact-bootstrap-script>';
style-src 'none'; img-src 'none'; font-src 'none'; connect-src 'none'; frame-src 'none';
object-src 'none'; base-uri 'none'; form-action 'none'; worker-src 'none'; script-src-attr 'none'
```

Notes:

- `script-src` uses a `sha256-...` hash of the fixture's exact inline bootstrap script — never
  `'unsafe-inline'` or `'unsafe-eval'`. [`csp.ts`](../../packages/shared/src/csp.ts)
  enforces this at build time (`buildMiniAppCsp` throws if given anything else), so a regression
  can't silently widen the policy.
- No directive uses `'self'`. For `srcdoc` content, relative URLs resolve against the *embedding*
  document's base URL while the frame's own origin is opaque — `'self'` would not reliably match
  anything and risks leaving an accidental path to host-origin resources.
- The [hello-sandbox fixture](../../apps/host/src/miniapp/fixtures/hello-sandbox) computes its
  script hash from the literal script source at build time
  (`buildFixture.ts`), so the declared hash and the executed bytes can never drift apart.

## Resource loading

`@openmini/runtime` does not ship a Node filesystem loader. It defines a provider interface:

```ts
interface MiniAppResourceProvider {
  readText(relativePath: string): Promise<string>;
}
```

`resolveEntryDocument` validates/canonicalizes the manifest's `entry` path, then reads it through
the caller-supplied provider; the resulting HTML becomes the iframe's `srcdoc`. Phase 3 shipped
`StaticFixtureResourceProvider` (an in-memory path → text map), for fixtures and the host demo.
Phase 6 adds a second implementation, `FetchResourceProvider`
(`createFetchResourceProvider(baseUrl)`, [`fetchResourceProvider.ts`](../../packages/runtime/src/sandbox/fetchResourceProvider.ts)),
which reads a Mini App package's files over HTTP from a fixed base URL — with **zero changes** to
`resolveEntryDocument`, `gateManifest`, `MiniAppHost`, or the sandbox/bridge pipeline, exactly as
this section previously said a filesystem- or HTTP-backed provider would require.

`loadMiniAppFromUrl(baseUrl)` (`loadMiniAppFromUrl.ts`) pairs a `FetchResourceProvider` with the
package's own fetched `openmini.json`, returning exactly the `{ manifestJson, resourceProvider }`
shape `MiniAppHost` already takes from any fixture. It deliberately does not parse or validate the
manifest itself — that still happens once, through the same `gateManifest` call every fixture goes
through today. `ok: false` from `loadMiniAppFromUrl` means only that the manifest could not even be
fetched (bad base URL, network failure, non-2xx response); manifest *content* errors surface
through `gateManifest` as before.

**Base URL contract.** Both `createFetchResourceProvider` and `loadMiniAppFromUrl` normalize the
caller-supplied base URL through a single shared helper, `normalizePackageBaseUrl`, before
resolving anything against it:

- Only `http:`/`https:` schemes are accepted; anything else (`file:`, `data:`, `javascript:`, or a
  URL that fails to parse at all) is rejected with a short, non-leaking error before any `fetch`
  is attempted — this is Phase 6's only new validation surface.
- `search` and `hash` are stripped unconditionally, so a query string or fragment on the supplied
  base URL can never influence where package files resolve.
- The path is forced to end with `/`, so a base URL with or without a trailing slash
  (`.../hello-remote` vs. `.../hello-remote/`) always resolves package-relative paths *inside*
  that package directory, never its parent — this matters because WHATWG `URL` resolution treats a
  base path without a trailing slash as a file, not a directory.

**Request policy (bounded, and failing closed).** Every package-load request — the manifest and
every resource — uses the same lifecycle the bridge's `network.fetch` uses
([`boundedFetch.ts`](../../packages/runtime/src/http/boundedFetch.ts)):

- `redirect: 'error'`. A base URL that redirects elsewhere means the bytes that arrive are not the
  bytes the URL named, so the load fails rather than silently following.
- A **5 MiB** cap per response, enforced *while bytes are read*: received bytes are counted per
  chunk and the reader is cancelled the moment the cap is passed. `Content-Length` is never
  consulted, so a missing or dishonest header cannot raise the ceiling.
- A **30 s** deadline covering the fetch *and* the body read, not the fetch call alone — a
  response that stalls after headers times out.

The limits (`PACKAGE_FETCH_TIMEOUT_MS`, `PACKAGE_MAX_RESOURCE_BYTES`) deliberately mirror the
`NETWORK_*` values: it is the same host issuing the same kind of request, so the two paths should
not disagree about what "too big" or "too slow" means.

**Containment is checked after resolution, not only before it.** `resolveContainedPath` inspects
the *shape of the input string*; `FetchResourceProvider` additionally verifies that the URL
`new URL(path, baseUrl)` actually produced is still under the package base, and refuses to issue
the request otherwise. The two are not interchangeable, because they do not even see the same
string: the shape check runs on the caller's raw input, while resolution runs on the rejoined,
percent-decoded segments — so a leading `./` or an encoded scheme (`./%68ttps:evil.com`) hides a
scheme from the input check entirely. The post-resolution check is the load-bearing one.

The host's "load by URL" control (`apps/host/src/App.tsx`) is a host-operator-facing tool, not a
Mini-App-facing capability — equivalent in trust terms to a user typing a URL into their own
browser's address bar. `fetch()` runs in the host's own trusted JS context, before any sandbox
exists; it does not grant a Mini App any new capability, only changes where the host gets the
bytes it was always going to hand to `srcdoc`. CSP correctness remains the package's own
responsibility, exactly as with `StaticFixtureResourceProvider` — the runtime never computes or
injects CSP into fetched content.

## Containment (path security)

[`containment.ts`](../../packages/runtime/src/sandbox/containment.ts) is a defense-in-depth layer,
independent of `@openmini/manifest`'s own entry-string-shape validation, exercised again at
resource-resolution time. It rejects:

- `../` traversal (including after decoding, e.g. `a/%2e%2e/b`)
- double-encoded traversal (e.g. `%252e%252e`, rejected outright rather than decoded in a loop)
- absolute POSIX paths (`/etc/passwd`)
- Windows drive paths (`C:\Windows\x`, `C:/Windows/x`) and UNC paths (`\\host\share`)
- backslashes as path separators
- URL-like entries, including a **bare `scheme:` with no `//`** (`https:evil.com`, `data:...`,
  `javascript:...`, `about:blank`) as well as protocol-relative `//host/...`
- malformed/empty segments

Accepted cost of matching a bare scheme: a relative path whose first segment contains a colon
(`my:file.html`) is rejected. Such names are already unusable on Windows.

The runtime never trusts manifest validation alone for this — `StaticFixtureResourceProvider` and
`resolveEntryDocument` both re-run containment on every path before touching file content.

This function answers a question about an input *string*, and is deliberately **not** the
authority on containment. A caller that resolves its output against a base URL must check the
result too; see the post-resolution guard described under "Resource loading".

## Manifest gate

A manifest is validated by [`@openmini/manifest`](../../packages/manifest) — via
[`gateManifest`](../../packages/runtime/src/sandbox/manifestGate.ts), a thin wrapper — **before**
any sandbox, iframe, or DOM object is created. The runtime does not duplicate manifest validation;
an invalid manifest halts before anything is instantiated.

## Lifecycle

```
created -> loading -> ready -> running
loading -> error
running -> error
any live state -> destroyed
```

`destroy()` is idempotent and safe to call from any state, including repeatedly. Once destroyed, a
sandbox instance ignores stale/late messages (a handshake-ack that arrives after `destroy()`, for
example, is a no-op) — see the state-machine tests in
[`createSandbox.test.ts`](../../packages/runtime/src/sandbox/createSandbox.test.ts). There is no
external state-machine dependency; the lifecycle is implemented directly.

## Known limitation: self-navigation is not fully prevented

**Phase 3 does not fully prevent the sandboxed iframe from navigating its own browsing context.**
`connect-src 'none'` blocks the Mini App's own `fetch`/`XHR`/`WebSocket`/etc. calls, but top-level
navigation of an iframe's *own* frame (e.g. via `location.href = ...` inside the sandboxed
document) is a separate browser behavior from CSP's `connect-src`/`frame-src`, and Phase 3 does not
add a dedicated countermeasure for it beyond `sandbox="allow-scripts"` itself.

The runtime does detect the resulting navigation after the fact: a second `load` event on the
iframe is treated as evidence the frame navigated away from its original `srcdoc` document, and a
`running`/`ready` sandbox is moved to `error` (`NAVIGATED_AWAY`) as a result. This is a
best-effort, after-the-fact signal — not a preventative control, and it does not inspect the
(opaque, inaccessible) destination.

This limitation is pinned by a Playwright regression test (`e2e/sandbox-self-navigation.spec.ts`)
that documents the current behavior rather than asserting complete network isolation. Do not treat
Phase 3 as providing full network isolation for the sandboxed frame.

## Testing split

- **Vitest/jsdom** (`packages/runtime/src/sandbox/*.test.ts`, `apps/host/src/miniapp/**/*.test.tsx`):
  containment logic, message envelope/type guards, the lifecycle state machine, the manifest gate,
  the resource provider, and host React wiring (manifest gating, button enablement, status text) —
  everywhere browser-native sandbox security is not being asserted. jsdom does not execute `srcdoc`
  script content, so it cannot exercise a real cross-frame handshake or CSP enforcement; the
  `createSandbox` unit tests instead inject a fake iframe/`contentWindow` via `SandboxRuntimeDeps`.
- **Playwright/real Chromium** (`e2e/`): the exact `sandbox` attribute, host DOM isolation, CSP
  enforcement, the real `MessageChannel` handshake, rejection of malformed/spoofed messages,
  destroy/recreate behavior, the invalid-manifest gate, and the documented self-navigation
  limitation above.
