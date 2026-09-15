import { MINI_APP_SANDBOX_ATTRIBUTE } from './csp';
import { OPENMINI_MESSAGE_CHANNEL, OPENMINI_PROTOCOL_VERSION, generateSessionId, isValidHandshakeAck } from './messaging';
import { resolveEntryDocument } from './resourceProvider';
import type {
  MiniAppSandbox,
  SandboxErrorInfo,
  SandboxOptions,
  SandboxState,
  SandboxStateListener,
} from './types';

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 5000;

/**
 * Minimal seams around real DOM/global constructors so the state-machine
 * logic here is unit-testable with plain fakes, without needing jsdom to
 * emulate cross-frame postMessage/MessagePort transfer (a real Chromium is
 * what actually proves that behavior — see e2e/). Not part of the public
 * SandboxOptions contract; production code always uses the defaults.
 */
export interface SandboxRuntimeDeps {
  createIframe(): HTMLIFrameElement;
  createMessageChannel(): MessageChannel;
}

const defaultDeps: SandboxRuntimeDeps = {
  createIframe: () => document.createElement('iframe'),
  createMessageChannel: () => new MessageChannel(),
};

class MiniAppSandboxImpl implements MiniAppSandbox {
  private _state: SandboxState = 'created';
  private readonly _sessionId = generateSessionId();
  private readonly listeners = new Set<SandboxStateListener>();
  private iframe: HTMLIFrameElement | null = null;
  private port: MessagePort | null = null;
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private loadCount = 0;
  private destroyed = false;

  constructor(
    private readonly options: SandboxOptions,
    private readonly deps: SandboxRuntimeDeps,
  ) {}

  get state(): SandboxState {
    return this._state;
  }

  get sessionId(): string {
    return this._sessionId;
  }

  onStateChange(listener: SandboxStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(state: SandboxState, info?: SandboxErrorInfo): void {
    for (const listener of this.listeners) {
      listener(state, info);
    }
  }

  private setState(state: SandboxState, info?: SandboxErrorInfo): void {
    if (this.destroyed) {
      return;
    }
    this._state = state;
    this.notify(state, info);
  }

  async start(): Promise<void> {
    if (this._state !== 'created') {
      return;
    }
    this.setState('loading');

    let entryHtml: string;
    try {
      const resolved = await resolveEntryDocument(this.options.manifest, this.options.resourceProvider);
      if (this.destroyed) {
        return;
      }
      if (!resolved.ok) {
        this.setState('error', { code: 'LOAD_FAILED', message: resolved.reason });
        return;
      }
      entryHtml = resolved.html;
    } catch (error) {
      if (this.destroyed) {
        return;
      }
      this.setState('error', {
        code: 'LOAD_FAILED',
        message: error instanceof Error ? error.message : 'failed to load entry document',
        cause: error,
      });
      return;
    }

    const iframe = this.deps.createIframe();
    iframe.setAttribute('sandbox', MINI_APP_SANDBOX_ATTRIBUTE);
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.addEventListener('load', this.handleLoad);
    this.iframe = iframe;
    // srcdoc assigned after listener attachment so the very first `load`
    // (once the iframe is in the document) is always observed.
    iframe.srcdoc = entryHtml;
    this.options.container.appendChild(iframe);
  }

  private readonly handleLoad = (): void => {
    if (this.destroyed) {
      return;
    }
    this.loadCount += 1;

    if (this.loadCount > 1) {
      // The sandboxed frame navigated away from its original srcdoc
      // document — a running/ready session is no longer healthy. This is
      // the simplest reliable signal Phase 3 relies on; it does not poll
      // location, inspect the (opaque, inaccessible) cross-origin URL, or
      // attempt to distinguish why the navigation happened. See
      // docs/security/sandbox.md "Self-navigation and lifecycle".
      if (this._state === 'running' || this._state === 'ready') {
        this.setState('error', {
          code: 'NAVIGATED_AWAY',
          message: 'the sandboxed frame navigated away from its original document',
        });
      }
      this.teardownMessaging();
      return;
    }

    if (this._state !== 'loading') {
      return;
    }
    this.setState('ready');
    this.beginHandshake();
  };

  private beginHandshake(): void {
    if (this.destroyed || !this.iframe || !this.iframe.contentWindow) {
      this.setState('error', { code: 'LOAD_FAILED', message: 'iframe has no contentWindow' });
      return;
    }

    const channel = this.deps.createMessageChannel();
    this.port = channel.port1;
    this.port.onmessage = this.handlePortMessage;

    const timeoutMs = this.options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
    this.handshakeTimer = setTimeout(() => {
      if (this._state === 'ready') {
        this.setState('error', {
          code: 'HANDSHAKE_TIMEOUT',
          message: 'handshake did not complete within the timeout',
        });
        this.teardownMessaging();
      }
    }, timeoutMs);

    // targetOrigin "*" is required here: the sandbox has an opaque origin
    // (no allow-same-origin), so there is no nameable origin string to
    // target exactly. This is a documented bootstrap necessity, not the
    // trust mechanism — trust comes from targeting this exact
    // iframe.contentWindow reference, a fresh MessageChannel/sessionId per
    // instance, and the strict source/shape/port-count validation the
    // fixture performs before accepting the transferred port. No secrets or
    // capabilities travel in this payload. See docs/security/sandbox.md.
    this.iframe.contentWindow.postMessage(
      {
        channel: OPENMINI_MESSAGE_CHANNEL,
        version: OPENMINI_PROTOCOL_VERSION,
        sessionId: this._sessionId,
        type: 'handshake-init',
      },
      '*',
      [channel.port2],
    );
  }

  private readonly handlePortMessage = (event: MessageEvent): void => {
    if (this.destroyed) {
      return;
    }
    if (!isValidHandshakeAck(event.data, this._sessionId)) {
      return;
    }
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this._state === 'ready') {
      this.setState('running');
      if (this.port) {
        this.options.onBridgeReady?.(this.port);
      }
    }
  };

  private teardownMessaging(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
    if (this.port) {
      this.port.onmessage = null;
      this.port.close();
      this.port = null;
    }
  }

  destroy(): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.teardownMessaging();
    if (this.iframe) {
      this.iframe.removeEventListener('load', this.handleLoad);
      this.iframe.remove();
      this.iframe = null;
    }
    this._state = 'destroyed';
    this.notify('destroyed');
    this.listeners.clear();
  }
}

export function createMiniAppSandbox(
  options: SandboxOptions,
  deps: SandboxRuntimeDeps = defaultDeps,
): MiniAppSandbox {
  return new MiniAppSandboxImpl(options, deps);
}
