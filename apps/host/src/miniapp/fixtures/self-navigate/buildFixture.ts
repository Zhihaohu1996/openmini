import { buildMiniAppCsp } from '@openmini/runtime';
import { sha256Base64Utf8 } from '@openmini/shared';
import { SELF_NAVIGATE_BOOTSTRAP_SCRIPT } from './bootstrapScript';

export async function buildSelfNavigateHtml(): Promise<string> {
  const hash = await sha256Base64Utf8(SELF_NAVIGATE_BOOTSTRAP_SCRIPT);
  const csp = buildMiniAppCsp(hash);

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
