import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import { resolveContainedPath } from '@openmini/runtime';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';

export interface DevServerOptions {
  /** Built package root — the directory holding openmini.json and the entry. */
  packageDir: string;
  /** Defaults to 4173. */
  port?: number;
  /**
   * Defaults to '127.0.0.1'. Loopback-only is the default deliberately; see
   * the note on `start` below before changing it.
   */
  host?: string;
}

export interface DevServer {
  readonly url: string;
  readonly port: number;
  close(): Promise<void>;
}

export const DEFAULT_DEV_PORT = 4173;
export const DEFAULT_DEV_HOST = '127.0.0.1';
const MANIFEST_FILENAME = 'openmini.json';

/**
 * Extensions the canonical package can contain. Anything else is refused
 * rather than guessed at or served as octet-stream: the package format is
 * two files, so an unknown extension means something is wrong.
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
});

/**
 * Serves a built Mini App package for local development.
 *
 * Hardened by default rather than by flag:
 *
 * - binds loopback only, so the package is never published to the LAN by
 *   simply running the dev server on an untrusted network;
 * - serves a single package directory, with every request path run through
 *   the runtime's own `resolveContainedPath` so traversal and directory
 *   escape are rejected by already-tested logic rather than new path code;
 * - never lists a directory;
 * - serves only known extensions, with explicit content types.
 *
 * The URL shape matches `normalizePackageBaseUrl`'s contract (http, no query
 * or hash, trailing slash) so `loadMiniAppFromUrl` works against it unchanged.
 */
export async function startDevServer(options: DevServerOptions): Promise<DevServer> {
  const packageDir = options.packageDir;
  const port = options.port ?? DEFAULT_DEV_PORT;
  const host = options.host ?? DEFAULT_DEV_HOST;

  const manifestRaw = await readFile(join(packageDir, MANIFEST_FILENAME), 'utf8');
  const manifestResult = parseManifest(manifestRaw);
  if (!manifestResult.valid) {
    throw new Error(formatManifestIssues(manifestResult.issues));
  }
  const entry = manifestResult.manifest.entry;

  const server = createServer((req, res) => {
    void handleRequest(req.url ?? '/', packageDir, entry)
      .then(({ status, body, contentType }) => {
        res.statusCode = status;
        if (contentType) {
          res.setHeader('content-type', contentType);
        }
        res.end(body);
      })
      .catch(() => {
        res.statusCode = 500;
        res.end('internal error');
      });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(port, host, () => {
      server.removeListener('error', rejectListen);
      resolveListen();
    });
  });

  // Port 0 asks the OS to pick, so report what was actually bound.
  const address = server.address();
  const boundPort = typeof address === 'object' && address !== null ? address.port : port;

  return {
    url: `http://${host}:${boundPort}/`,
    port: boundPort,
    close: () => closeServer(server),
  };
}

interface ServeResult {
  status: number;
  body: string | Buffer;
  contentType?: string;
}

async function handleRequest(rawUrl: string, packageDir: string, entry: string): Promise<ServeResult> {
  // Strip query/hash before any path handling; they never select a file.
  const pathname = rawUrl.split('?')[0]?.split('#')[0] ?? '/';
  const requested = pathname === '/' ? entry : decodeURIComponent(pathname.replace(/^\/+/, ''));

  if (requested === '') {
    return { status: 404, body: 'not found' };
  }

  const contained = resolveContainedPath(requested);
  if (!contained.ok) {
    return { status: 403, body: `path rejected (${contained.reason})` };
  }

  const relative = contained.segments.join('/');
  const contentType = CONTENT_TYPES[extname(relative).toLowerCase()];
  if (!contentType) {
    return { status: 415, body: 'unsupported file type for a Mini App package' };
  }

  try {
    const body = await readFile(join(packageDir, relative));
    return { status: 200, body, contentType };
  } catch {
    // Directories and missing files are indistinguishable to the caller —
    // there is deliberately no listing.
    return { status: 404, body: 'not found' };
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.close(() => resolveClose());
  });
}
