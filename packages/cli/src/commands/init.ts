import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

export interface InitOptions {
  /** Directory to scaffold into. Created if missing. */
  projectDir: string;
  /** Reverse-domain Mini App id, e.g. com.example.hello. */
  id: string;
  /** Human-readable name. Defaults to the id's last segment. */
  name?: string;
}

export interface InitResult {
  projectDir: string;
  files: string[];
}

/**
 * Scaffolds an authoring project: a manifest, an HTML shell and an entry
 * script. The layout separates authoring sources (`src/`) from the package
 * that `openmini build` emits, so nothing here ends up shipped by accident.
 *
 * The HTML shell is deliberately written to satisfy the sandbox's
 * constraints: an empty <script></script> placeholder for the bundled code,
 * an inline <style> block rather than a stylesheet link, and no CSP meta —
 * the CLI owns that.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const projectDir = resolve(options.projectDir);
  const name = options.name ?? options.id.split('.').pop() ?? options.id;

  const manifest = `${JSON.stringify(
    {
      schemaVersion: 1,
      id: options.id,
      name,
      version: '0.1.0',
      entry: 'index.html',
      permissions: [],
    },
    null,
    2,
  )}\n`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${name}</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 2rem; }
  #status { color: #333; }
</style>
</head>
<body>
<h1>${name}</h1>
<p id="status">starting...</p>
<script></script>
</body>
</html>
`;

  const script = `import { connectOpenMini } from '@openmini/sdk';

async function main(): Promise<void> {
  const openmini = await connectOpenMini();
  const profile = await openmini.user.getProfile();

  const status = document.getElementById('status');
  if (status) {
    status.textContent = \`connected (user: \${profile.id ?? 'anonymous'})\`;
  }
}

void main();
`;

  // The entry script imports @openmini/sdk, so the scaffold declares it —
  // otherwise the first `openmini build` fails on an unresolved import.
  const packageJson = `${JSON.stringify(
    {
      name: name.toLowerCase().replace(/[^a-z0-9-]+/g, '-'),
      version: '0.1.0',
      private: true,
      type: 'module',
      dependencies: { '@openmini/sdk': '^0.1.0' },
    },
    null,
    2,
  )}\n`;

  await mkdir(join(projectDir, 'src'), { recursive: true });
  await writeFile(join(projectDir, 'openmini.json'), manifest, 'utf8');
  await writeFile(join(projectDir, 'package.json'), packageJson, 'utf8');
  await writeFile(join(projectDir, 'src', 'index.html'), html, 'utf8');
  await writeFile(join(projectDir, 'src', 'main.ts'), script, 'utf8');

  return {
    projectDir,
    files: ['openmini.json', 'package.json', 'src/index.html', 'src/main.ts'],
  };
}
