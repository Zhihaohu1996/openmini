import { formatManifestIssues, parseManifest } from '@openmini/manifest';
import { build as esbuild } from 'esbuild';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { PackageBuildError, assembleEntryDocument } from '../packageBuild.js';

export interface BuildOptions {
  /** Authoring project root — the directory containing openmini.json. */
  projectDir: string;
  /** Output package root. Receives exactly the files the loader consumes. */
  outDir: string;
  /** Author's HTML shell, relative to projectDir. */
  htmlPath?: string;
  /** Entry script, relative to projectDir. */
  scriptPath?: string;
}

export interface BuildResult {
  outDir: string;
  entryFile: string;
  manifestFile: string;
  csp: string;
}

const DEFAULT_HTML_PATH = 'src/index.html';
const DEFAULT_SCRIPT_PATH = 'src/main.ts';
const MANIFEST_FILENAME = 'openmini.json';

/**
 * Bundles an authoring project into a canonical Mini App package.
 *
 * The output contains only what the loader actually reads — `openmini.json`
 * and the built entry document — so `src/`, configs and anything else in the
 * authoring project stay out of the shipped package.
 *
 * The build is deterministic: identical inputs and tool version produce
 * byte-identical output. Nothing timestamped, absolute, random or
 * locale-dependent is written. This matters beyond tidiness — a later phase
 * intends to digest/sign these artifacts, and a digest is meaningless if a
 * rebuild changes bytes.
 */
export async function buildPackage(options: BuildOptions): Promise<BuildResult> {
  const projectDir = resolve(options.projectDir);
  const outDir = resolve(options.outDir);
  const htmlPath = options.htmlPath ?? DEFAULT_HTML_PATH;
  const scriptPath = options.scriptPath ?? DEFAULT_SCRIPT_PATH;

  // Read the manifest as bytes and copy it through verbatim. Re-serializing
  // would let key order or formatting drift between runs.
  const manifestBytes = await readFile(join(projectDir, MANIFEST_FILENAME));
  const manifestResult = parseManifest(manifestBytes.toString('utf8'));
  if (!manifestResult.valid) {
    throw new PackageBuildError(formatManifestIssues(manifestResult.issues));
  }
  const manifest = manifestResult.manifest;

  const html = await readFile(join(projectDir, htmlPath), 'utf8');

  const bundled = await esbuild({
    entryPoints: [scriptPath],
    // Relative entry + a fixed working directory keeps esbuild's own path
    // comments relative, so no absolute path from this machine is baked in.
    absWorkingDir: projectDir,
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    sourcemap: false,
    legalComments: 'none',
  });

  const script = bundled.outputFiles[0]?.text;
  if (script === undefined) {
    throw new PackageBuildError(`bundling produced no output for ${scriptPath}`);
  }

  const assembled = assembleEntryDocument({ html, script });

  // Normalize to LF so the same source yields the same bytes regardless of
  // the platform the build runs on.
  const documentBytes = Buffer.from(assembled.html.replace(/\r\n/g, '\n'), 'utf8');

  const entryTarget = join(outDir, manifest.entry);
  await rm(outDir, { recursive: true, force: true });
  await mkdir(dirname(entryTarget), { recursive: true });
  await writeFile(entryTarget, documentBytes);
  await writeFile(join(outDir, MANIFEST_FILENAME), manifestBytes);

  return {
    outDir,
    entryFile: manifest.entry,
    manifestFile: MANIFEST_FILENAME,
    csp: assembled.csp,
  };
}
