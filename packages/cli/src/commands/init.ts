import { formatManifestIssues, validateManifest } from '@openmini/manifest';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

/** Thrown for a rejected `--id` and for scaffold destination conflicts. */
export class InitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InitError';
  }
}

export interface InitOptions {
  /** Directory to scaffold into. Created if missing. */
  projectDir: string;
  /** Reverse-domain Mini App id, e.g. com.example.hello. */
  id: string;
  /** Human-readable name. Defaults to the id's last segment. */
  name?: string;
  /** Overwrite existing destination files instead of refusing. */
  force?: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
 *
 * Two guarantees (R5, Phase 8.5):
 *
 * 1. The manifest is validated with the same `validateManifest` that
 *    `openmini validate` uses, before anything is written. The two commands
 *    therefore agree by construction rather than by coincidence — previously
 *    `init --id NOPE` happily produced a project that `validate` rejected.
 * 2. Without `--force`, a conflict on *any* destination leaves the filesystem
 *    byte-for-byte unchanged: no files written, and no `src/` directory
 *    created as a side effect.
 */
export async function initProject(options: InitOptions): Promise<InitResult> {
  const projectDir = resolve(options.projectDir);
  const name = options.name ?? options.id.split('.').pop() ?? options.id;

  const manifestObject = {
    schemaVersion: 1,
    id: options.id,
    name,
    version: '0.1.0',
    entry: 'index.html',
    permissions: [],
  };

  const validation = validateManifest(manifestObject);
  if (!validation.valid) {
    throw new InitError(formatManifestIssues(validation.issues));
  }

  const manifest = `${JSON.stringify(manifestObject, null, 2)}\n`;

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
  const status = document.getElementById('status');

  // connectOpenMini rejects with a HANDSHAKE_TIMEOUT BridgeError if the host
  // never completes the handshake. Handle it: an app that ignores the
  // rejection just sits on "starting..." with no bridge and no explanation.
  let openmini;
  try {
    openmini = await connectOpenMini();
  } catch (error) {
    if (status) {
      status.textContent = \`could not reach the host: \${(error as Error).message}\`;
    }
    return;
  }

  const profile = await openmini.user.getProfile();
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

  // Every destination, computed up front so the preflight below can see all
  // of them. The order here is also the write order.
  const targets = [
    { relative: 'openmini.json', path: join(projectDir, 'openmini.json'), contents: manifest },
    { relative: 'package.json', path: join(projectDir, 'package.json'), contents: packageJson },
    { relative: 'src/index.html', path: join(projectDir, 'src', 'index.html'), contents: html },
    { relative: 'src/main.ts', path: join(projectDir, 'src', 'main.ts'), contents: script },
  ];

  if (!options.force) {
    // Check *all* destinations before creating anything. Sequential writes
    // with no preflight meant a conflict on the last file (`src/main.ts`)
    // left the first three already overwritten — the worst case, because
    // `openmini.json` and `package.json` are the two a user is most likely to
    // have authored themselves. Reporting every conflict at once also saves
    // the author from rediscovering them one run at a time.
    const conflicts: string[] = [];
    for (const target of targets) {
      if (await exists(target.path)) {
        conflicts.push(target.relative);
      }
    }
    if (conflicts.length > 0) {
      throw new InitError(
        `refusing to overwrite existing files in ${projectDir}:\n${conflicts
          .map((file) => `  ${file}`)
          .join('\n')}\nPass --force to overwrite.`,
      );
    }
  }

  // Preflight, not a transaction: this makes *conflict handling* atomic. It
  // does not make the write phase atomic against a mid-write I/O failure
  // (disk full, permissions), and the error text above does not imply it.
  await mkdir(join(projectDir, 'src'), { recursive: true });
  for (const target of targets) {
    await writeFile(target.path, target.contents, 'utf8');
  }

  return {
    projectDir,
    files: targets.map((target) => target.relative),
  };
}
