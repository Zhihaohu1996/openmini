import { buildMiniAppCsp } from '@openmini/runtime';
import { HELLO_SANDBOX_BOOTSTRAP_SCRIPT } from './bootstrapScript';

function bufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

async function sha256Base64(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return bufferToBase64(digest);
}

/**
 * Builds the hello-sandbox fixture's `index.html` at call time, computing
 * the CSP's `script-src` hash from {@link HELLO_SANDBOX_BOOTSTRAP_SCRIPT}
 * itself (via `buildMiniAppCsp`) rather than a hand-copied constant, so the
 * declared hash and the shipped script can never silently drift apart.
 */
export async function buildHelloSandboxHtml(): Promise<string> {
  const hash = await sha256Base64(HELLO_SANDBOX_BOOTSTRAP_SCRIPT);
  const csp = buildMiniAppCsp(`sha256-${hash}`);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>hello-sandbox</title>
</head>
<body>
<h1 id="hello">Hello from OpenMini Sandbox</h1>
<p id="isolation-check">checking...</p>
<p id="connect-check">checking...</p>
<script>${HELLO_SANDBOX_BOOTSTRAP_SCRIPT}</script>
</body>
</html>
`;
}
