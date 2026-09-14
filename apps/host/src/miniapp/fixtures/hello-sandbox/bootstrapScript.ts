/**
 * The hello-sandbox fixture's entire inline script, as a literal string.
 * Kept separate from the HTML template so `buildFixture.ts` can hash this
 * exact source for the document's `script-src 'sha256-...'` CSP directive —
 * the hash and the executed bytes can never drift apart.
 *
 * Runs inside the sandboxed (`allow-scripts` only, no `allow-same-origin`)
 * document, so it has an opaque origin: it cannot import runtime code
 * (`@openmini/runtime`'s messaging helpers), so the envelope check below is
 * a small, deliberately duplicated copy of that same shape check.
 */
export const HELLO_SANDBOX_BOOTSTRAP_SCRIPT = `(function () {
  var CHANNEL = 'openmini';
  var VERSION = 1;

  function isEnvelope(data) {
    return (
      data !== null &&
      typeof data === 'object' &&
      data.channel === CHANNEL &&
      data.version === VERSION &&
      typeof data.sessionId === 'string' &&
      data.sessionId.length > 0 &&
      (data.type === 'handshake-init' || data.type === 'handshake-ack')
    );
  }

  function onBootstrap(event) {
    if (event.source !== window.parent) {
      return;
    }
    if (!event.ports || event.ports.length !== 1) {
      return;
    }
    if (!isEnvelope(event.data) || event.data.type !== 'handshake-init') {
      return;
    }

    window.removeEventListener('message', onBootstrap);
    var port = event.ports[0];
    port.postMessage({
      channel: CHANNEL,
      version: VERSION,
      sessionId: event.data.sessionId,
      type: 'handshake-ack',
    });
  }

  window.addEventListener('message', onBootstrap);

  var isolationEl = document.getElementById('isolation-check');
  try {
    void window.parent.document.title;
    isolationEl.textContent = 'NOT ISOLATED';
  } catch (err) {
    isolationEl.textContent = 'isolated';
  }

  var connectEl = document.getElementById('connect-check');
  fetch('https://example.invalid/should-be-blocked')
    .then(function () {
      connectEl.textContent = 'NOT BLOCKED';
    })
    .catch(function () {
      connectEl.textContent = 'blocked';
    });
})();`;
