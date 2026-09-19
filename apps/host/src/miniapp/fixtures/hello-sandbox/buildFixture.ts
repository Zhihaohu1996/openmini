import { buildMiniAppCsp } from '@openmini/runtime';
import { sha256Base64Utf8 } from '@openmini/shared';
import { HELLO_SANDBOX_BOOTSTRAP_SCRIPT } from './bootstrapScript';

/**
 * Builds the hello-sandbox fixture's `index.html` at call time, computing
 * the CSP's `script-src` hash from {@link HELLO_SANDBOX_BOOTSTRAP_SCRIPT}
 * itself (via `buildMiniAppCsp`) rather than a hand-copied constant, so the
 * declared hash and the shipped script can never silently drift apart.
 */
export async function buildHelloSandboxHtml(): Promise<string> {
  const hash = await sha256Base64Utf8(HELLO_SANDBOX_BOOTSTRAP_SCRIPT);
  const csp = buildMiniAppCsp(hash);

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
