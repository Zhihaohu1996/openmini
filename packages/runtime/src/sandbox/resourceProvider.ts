import type { OpenMiniManifest } from '@openmini/manifest';
import { resolveContainedPath } from './containment';
import type { MiniAppResourceProvider } from './types';

export type { MiniAppResourceProvider };

/**
 * Phase 3's only MiniAppResourceProvider implementation: an in-memory map of
 * relative path -> text content. Deliberately not a filesystem or HTTP
 * loader — those are future CLI/Desktop/Server concerns that can implement
 * this same interface (reading/fetching internally) without any change to
 * sandbox/lifecycle code.
 */
export class StaticFixtureResourceProvider implements MiniAppResourceProvider {
  constructor(private readonly files: Readonly<Record<string, string>>) {}

  async readText(relativePath: string): Promise<string> {
    const containment = resolveContainedPath(relativePath);
    if (!containment.ok) {
      throw new Error(`resource path rejected (${containment.reason}): ${relativePath}`);
    }

    const key = containment.segments.join('/');
    // Own properties only. This class is exported and its contract is
    // `Promise<string>`, rejecting for a path not in its map, but a bare index
    // answered an `Object.prototype` member for a prototype-named path:
    // `constructor` resolved with the `Object` function and `__proto__` with
    // `Object.prototype`, and `resolveEntryDocument` passed either on as the
    // entry's html. The map holds strings, so `hasOwn` is the whole of it.
    const content = Object.hasOwn(this.files, key) ? this.files[key] : undefined;
    if (content === undefined) {
      throw new Error(`resource not found in fixture: ${relativePath}`);
    }
    return content;
  }
}

export type ResolveEntryDocumentResult = { ok: true; html: string } | { ok: false; reason: string };

/**
 * Resolves a manifest's `entry` to loadable document text: re-validates
 * containment independent of @openmini/manifest's own string-shape check,
 * then reads the resource through the given provider. The returned `html`
 * is used directly as the sandbox iframe's `srcdoc`.
 */
export async function resolveEntryDocument(
  manifest: OpenMiniManifest,
  provider: MiniAppResourceProvider,
): Promise<ResolveEntryDocumentResult> {
  const containment = resolveContainedPath(manifest.entry);
  if (!containment.ok) {
    return { ok: false, reason: `entry path rejected (${containment.reason})` };
  }

  try {
    const html = await provider.readText(manifest.entry);
    return { ok: true, html };
  } catch (error) {
    return {
      ok: false,
      reason: error instanceof Error ? error.message : 'failed to read entry resource',
    };
  }
}
