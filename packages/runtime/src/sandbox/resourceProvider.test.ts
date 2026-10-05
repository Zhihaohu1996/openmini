import type { OpenMiniManifest } from '@openmini/manifest';
import { describe, expect, it } from 'vitest';
import { StaticFixtureResourceProvider, resolveEntryDocument } from './resourceProvider';

function makeManifest(entry: string): OpenMiniManifest {
  return {
    schemaVersion: 1,
    id: 'com.openmini.test',
    name: 'Test App',
    version: '0.1.0',
    entry,
    permissions: [],
  };
}

describe('StaticFixtureResourceProvider', () => {
  it('reads text for a known relative path', async () => {
    const provider = new StaticFixtureResourceProvider({ 'index.html': '<h1>hi</h1>' });
    await expect(provider.readText('index.html')).resolves.toBe('<h1>hi</h1>');
  });

  it('rejects a path that escapes containment before consulting the file map', async () => {
    const provider = new StaticFixtureResourceProvider({ '../secret.html': 'leaked' });
    await expect(provider.readText('../secret.html')).rejects.toThrow(/resource path rejected/);
  });

  it('rejects a path not present in the fixture map', async () => {
    const provider = new StaticFixtureResourceProvider({ 'index.html': '<h1>hi</h1>' });
    await expect(provider.readText('missing.html')).rejects.toThrow(/resource not found/);
  });

  // Phase 14 W3. The map's own keys are the whole of what the provider
  // serves; an inherited member is not a file. Without the own-property gate
  // each of these resolved with a function or Object.prototype.
  it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__'])(
    'rejects the inherited name %j instead of resolving with its value',
    async (name) => {
      const provider = new StaticFixtureResourceProvider({ 'index.html': '<h1>hi</h1>' });
      await expect(provider.readText(name)).rejects.toThrow(
        `resource not found in fixture: ${name}`,
      );
    },
  );

  it('serves a genuine own __proto__ key', async () => {
    // Built with assignment on a null-prototype object: in an object literal
    // `__proto__:` sets the prototype and never becomes an own key.
    const files: Record<string, string> = Object.create(null);
    files['__proto__'] = '<h1>proto</h1>';
    expect(Object.hasOwn(files, '__proto__')).toBe(true);

    const provider = new StaticFixtureResourceProvider(files);
    await expect(provider.readText('__proto__')).resolves.toBe('<h1>proto</h1>');
  });
});

describe('resolveEntryDocument', () => {
  it('returns the fixture html for a valid entry', async () => {
    const provider = new StaticFixtureResourceProvider({ 'index.html': '<h1>Hello</h1>' });
    const result = await resolveEntryDocument(makeManifest('index.html'), provider);
    expect(result).toEqual({ ok: true, html: '<h1>Hello</h1>' });
  });

  it('rejects an entry whose path escapes containment, before touching the provider', async () => {
    const provider = new StaticFixtureResourceProvider({});
    const result = await resolveEntryDocument(makeManifest('../escape.html'), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/entry path rejected/);
    }
  });

  it('surfaces a provider read failure as a structured error result', async () => {
    const provider = new StaticFixtureResourceProvider({});
    const result = await resolveEntryDocument(makeManifest('index.html'), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/resource not found/);
    }
  });

  it('refuses an entry named after an inherited member instead of returning it as html', async () => {
    const provider = new StaticFixtureResourceProvider({ 'index.html': '<h1>Hello</h1>' });
    const result = await resolveEntryDocument(makeManifest('constructor'), provider);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('resource not found in fixture: constructor');
    }
  });
});
