/**
 * Bootstrap script for the self-navigate fixture, used only by the
 * Playwright regression test for the documented Phase 3 self-navigation
 * limitation (see docs/security/sandbox.md). Completes the same handshake
 * as hello-sandbox, then — shortly after — navigates its own browsing
 * context. `connect-src 'none'` does not prevent this: it is a distinct
 * browser behavior from network/CSP enforcement.
 */
export const SELF_NAVIGATE_BOOTSTRAP_SCRIPT = `(function () {
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

    setTimeout(function () {
      window.location.href = 'about:blank';
    }, 200);
  }

  window.addEventListener('message', onBootstrap);
})();`;
