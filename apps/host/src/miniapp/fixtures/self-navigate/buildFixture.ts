import { buildMiniAppCsp } from '@openmini/runtime';
import { SELF_NAVIGATE_BOOTSTRAP_SCRIPT } from './bootstrapScript';

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

export async function buildSelfNavigateHtml(): Promise<string> {
  const hash = await sha256Base64(SELF_NAVIGATE_BOOTSTRAP_SCRIPT);
  const csp = buildMiniAppCsp(`sha256-${hash}`);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<title>self-navigate</title>
</head>
<body>
<h1>self-navigate fixture</h1>
<script>${SELF_NAVIGATE_BOOTSTRAP_SCRIPT}</script>
</body>
</html>
`;
}
