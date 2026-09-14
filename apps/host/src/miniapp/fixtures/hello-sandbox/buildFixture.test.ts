import { describe, expect, it } from 'vitest';
import { buildHelloSandboxHtml } from './buildFixture';
import { HELLO_SANDBOX_BOOTSTRAP_SCRIPT } from './bootstrapScript';

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = new Uint8Array(digest);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

describe('buildHelloSandboxHtml', () => {
  it('embeds a CSP script-src hash that matches the actual inline script', async () => {
    const html = await buildHelloSandboxHtml();
    const expectedHash = await sha256Base64(HELLO_SANDBOX_BOOTSTRAP_SCRIPT);
    expect(html).toContain(`script-src 'sha256-${expectedHash}'`);
  });

  it('embeds the exact bootstrap script as the only inline script', async () => {
    const html = await buildHelloSandboxHtml();
    expect(html).toContain(`<script>${HELLO_SANDBOX_BOOTSTRAP_SCRIPT}</script>`);
  });

  it('never allows unsafe-inline, unsafe-eval, or "self" in the CSP', async () => {
    const html = await buildHelloSandboxHtml();
    const cspMatch = html.match(/content="([^"]+)"/);
    expect(cspMatch).not.toBeNull();
    const csp = cspMatch?.[1] ?? '';
    expect(csp.toLowerCase()).not.toContain('unsafe-inline');
    expect(csp.toLowerCase()).not.toContain('unsafe-eval');
    expect(csp).not.toContain("'self'");
  });

  it('renders the visible "Hello from OpenMini Sandbox" heading', async () => {
    const html = await buildHelloSandboxHtml();
    expect(html).toContain('Hello from OpenMini Sandbox');
  });
});
