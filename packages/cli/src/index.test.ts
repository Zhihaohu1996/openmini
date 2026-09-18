import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPENMINI_CLI_VERSION } from './index';

describe('@openmini/cli', () => {
  it('reports the same version as package.json', async () => {
    // Comparing against a literal only proved the constant equalled itself.
    // The version is user-visible (`openmini --version`) and is what a bug
    // report will quote, so what matters is that it tracks the published
    // package version rather than drifting from it silently.
    const packageJsonPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const { version } = JSON.parse(await readFile(packageJsonPath, 'utf8')) as { version: string };

    expect(OPENMINI_CLI_VERSION).toBe(version);
  });
});
