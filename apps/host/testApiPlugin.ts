import { createServer, type ServerResponse } from 'node:http';
import type { Plugin } from 'vite';

/**
 * Dev-server-only HTTP endpoints for the Phase 7 `network.fetch` e2e specs.
 *
 * These exist because the behaviors under test cannot be expressed as static
 * files: a real 3xx redirect, a response that deliberately omits CORS
 * headers, and a server-side record of which paths were actually requested
 * (which is how the redirect spec proves the redirect target was never
 * reached, rather than merely that its content never surfaced).
 *
 * The same handlers are also served on a second port, which is a genuinely
 * different origin from the host page, so a spec can exercise real
 * cross-origin CORS. A second *port* rather than `127.0.0.1` because Vite
 * binds to `localhost` only, leaving the IPv4 loopback unreachable.
 *
 * `apply: 'serve'` keeps all of this out of any production build.
 */
export const TEST_API_CROSS_ORIGIN_PORT = 5174;

export function testApiPlugin(): Plugin {
  const hits = new Map<string, number>();

  function recordHit(path: string): void {
    hits.set(path, (hits.get(path) ?? 0) + 1);
  }

  /** Returns false when the path isn't ours, so the caller can fall through. */
  function handle(path: string, res: ServerResponse): boolean {
    // Every response is CORS-open except /no-cors, so a spec can tell an
    // allowlisted-but-CORS-blocked request apart from an allowed one.
    if (path !== '/no-cors') {
      res.setHeader('access-control-allow-origin', '*');
    }

    switch (path) {
      case '/echo':
        recordHit(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('echo-ok');
        return true;

      case '/no-cors':
        recordHit(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('should-not-be-readable');
        return true;

      case '/redirect':
        recordHit(path);
        res.statusCode = 302;
        res.setHeader('location', '/test-api/secret');
        res.end();
        return true;

      // Reached only if a redirect were followed — which is exactly what
      // the fail-closed policy must prevent.
      case '/secret':
        recordHit(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('REDIRECT-TARGET-CONTENT');
        return true;

      // 6 MiB, over the host's 5 MiB response cap. Sent without a
      // content-length so the body actually streams through; the cap must
      // stop it. (Header-independence is covered by the unit tests, which
      // can construct a lying Content-Length the client won't truncate on.)
      case '/large':
        recordHit(path);
        res.statusCode = 200;
        res.setHeader('content-type', 'text/plain');
        res.end('x'.repeat(6 * 1024 * 1024));
        return true;

      // Process-wide and never reset: specs run in parallel, so they assert
      // against it in ways that don't depend on an exact count.
      case '/hits':
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(Object.fromEntries(hits)));
        return true;

      default:
        return false;
    }
  }

  /**
   * The path portion of a request URL. `split` always yields at least one
   * element, but `noUncheckedIndexedAccess` cannot know that, so the fallback
   * is written out rather than asserted away — and it is the same `/` default
   * already used for a missing `req.url`.
   */
  function pathOf(rawUrl: string | undefined): string {
    return (rawUrl ?? '/').split('?')[0] ?? '/';
  }

  return {
    name: 'openmini-test-api',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/test-api', (req, res, next) => {
        if (!handle(pathOf(req.url), res)) {
          next();
        }
      });

      const crossOrigin = createServer((req, res) => {
        const url = pathOf(req.url);
        const path = url.startsWith('/test-api') ? url.slice('/test-api'.length) : url;
        if (!handle(path || '/', res)) {
          res.statusCode = 404;
          res.end();
        }
      });
      // A stale listener on this port must not take the whole dev server
      // down with it; only the cross-origin specs depend on it.
      crossOrigin.on('error', (error) => {
        server.config.logger.warn(`[test-api] cross-origin fixture server unavailable: ${error.message}`);
      });
      crossOrigin.listen(TEST_API_CROSS_ORIGIN_PORT, 'localhost');
      server.httpServer?.on('close', () => crossOrigin.close());
    },
  };
}
