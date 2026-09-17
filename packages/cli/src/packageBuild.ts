import { buildMiniAppCsp } from '@openmini/shared';
import { createHash } from 'node:crypto';

/**
 * Assembles a Mini App entry document from an author's HTML shell plus a
 * bundled script, and generates the CSP that document must carry.
 *
 * This module is intentionally free of filesystem and bundler concerns so it
 * can be unit-tested directly on strings: `build.ts` supplies the bundled
 * script, this decides what the final document looks like.
 *
 * The runtime loads a Mini App as a single `srcdoc` document whose CSP allows
 * exactly one inline script by hash and forbids every other resource type.
 * Rather than let an author discover that at load time as a blank frame, the
 * unsupported constructs below are rejected here, at build time, with an
 * explanation.
 */

export interface AssembleOptions {
  /** The author's HTML, which must contain a placeholder script element. */
  html: string;
  /** The bundled, ready-to-inline script text. */
  script: string;
}

export interface AssembleResult {
  html: string;
  csp: string;
  scriptHashSource: string;
  styleHashSources: string[];
}

export class PackageBuildError extends Error {}

function sha256Base64(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('base64');
}

/**
 * Each rule names a construct the sandbox CSP makes unusable, and says what
 * to do instead. The goal is that the tool teaches the platform's
 * constraints rather than just refusing.
 */
const UNSUPPORTED_CONSTRUCTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
  readonly why: string;
}> = [
  {
    pattern: /<script\b[^>]*\bsrc\s*=/i,
    what: 'an external <script src="...">',
    why: "script-src allows exactly one inline script by hash, so external scripts can never load. Import the code into your entry script instead — it is bundled and inlined for you.",
  },
  {
    pattern: /<link\b[^>]*\brel\s*=\s*["']?stylesheet/i,
    what: 'an external stylesheet (<link rel="stylesheet">)',
    why: 'style-src allows only a hashed inline <style> block. Move the CSS into an inline <style> element.',
  },
  {
    pattern: /<\w+\b[^>]*\son[a-z]+\s*=/i,
    what: 'an inline event handler attribute (e.g. onclick="...")',
    why: "script-src-attr is 'none' and a hash does not lift that. Attach listeners from your script with addEventListener instead.",
  },
  {
    pattern: /<\w+\b[^>]*\sstyle\s*=/i,
    what: 'a style="..." attribute',
    why: "style attributes are governed by style-src-attr, and CSP hashes do not apply to attributes (that would need 'unsafe-hashes', which this policy will not add). Use a class and an inline <style> block.",
  },
  {
    pattern: /<img\b/i,
    what: 'an <img> element',
    why: "img-src is 'none'. Remote and inline images are not supported in this phase.",
  },
  {
    pattern: /<iframe\b/i,
    what: 'an <iframe> element',
    why: "frame-src is 'none'. A Mini App cannot embed further frames.",
  },
  {
    pattern: /<object\b|<embed\b/i,
    what: 'an <object>/<embed> element',
    why: "object-src is 'none'.",
  },
  {
    pattern: /<form\b/i,
    what: 'a <form> element',
    why: "form-action is 'none', so submission is blocked. Use openmini.network.fetch to send data instead.",
  },
  {
    pattern: /<base\b/i,
    what: 'a <base> element',
    why: "base-uri is 'none'.",
  },
];

/** Script-side constructs the policy cannot permit. */
const UNSUPPORTED_SCRIPT_CONSTRUCTS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly what: string;
  readonly why: string;
}> = [
  {
    pattern: /\beval\s*\(/,
    what: 'a call to eval()',
    why: "script-src permits a hash only; 'unsafe-eval' is never added.",
  },
  {
    pattern: /\bnew\s+Function\s*\(/,
    what: 'new Function(...)',
    why: "this is eval by another name and is blocked for the same reason ('unsafe-eval' is never added).",
  },
  {
    pattern: /\bimport\s*\(/,
    what: 'a dynamic import()',
    why: 'the document is rendered via srcdoc in an opaque origin, so a dynamic import has no base URL to resolve against. Use a static import; it is bundled and inlined.',
  },
];

const CSP_META_PATTERN = /<meta\b[^>]*http-equiv\s*=\s*["']?content-security-policy/i;
const STYLE_BLOCK_PATTERN = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
/** The placeholder the author writes; the bundled script replaces it. */
const SCRIPT_PLACEHOLDER_PATTERN = /<script\b[^>]*>\s*<\/script>/i;

function assertNoUnsupportedConstructs(html: string, script: string): void {
  for (const rule of UNSUPPORTED_CONSTRUCTS) {
    if (rule.pattern.test(html)) {
      throw new PackageBuildError(`unsupported: ${rule.what}. ${rule.why}`);
    }
  }
  for (const rule of UNSUPPORTED_SCRIPT_CONSTRUCTS) {
    if (rule.pattern.test(script)) {
      throw new PackageBuildError(`unsupported: ${rule.what} in the entry script. ${rule.why}`);
    }
  }
}

/**
 * Builds the final document. The CLI — never the author — owns the CSP: an
 * author-supplied policy is refused outright rather than merged, because
 * silently combining two security policies is precisely the failure mode
 * worth refusing.
 */
export function assembleEntryDocument({ html, script }: AssembleOptions): AssembleResult {
  if (CSP_META_PATTERN.test(html)) {
    throw new PackageBuildError(
      'the entry HTML already declares a Content-Security-Policy <meta>. The CLI generates the policy; remove yours rather than having two.',
    );
  }

  assertNoUnsupportedConstructs(html, script);

  if (!SCRIPT_PLACEHOLDER_PATTERN.test(html)) {
    throw new PackageBuildError(
      'the entry HTML has no empty <script></script> placeholder for the bundled code to be inlined into.',
    );
  }

  const styleHashSources: string[] = [];
  for (const match of html.matchAll(STYLE_BLOCK_PATTERN)) {
    styleHashSources.push(`sha256-${sha256Base64(match[1] ?? '')}`);
  }

  const scriptHashSource = `sha256-${sha256Base64(script)}`;
  const csp = buildMiniAppCsp(scriptHashSource, styleHashSources);

  // `$&`-style replacement patterns in bundled code would be interpreted by
  // String.replace, so use a function replacer to insert it verbatim.
  const withScript = html.replace(SCRIPT_PLACEHOLDER_PATTERN, () => `<script>${script}</script>`);
  const withCsp = injectCspMeta(withScript, csp);

  return { html: withCsp, csp, scriptHashSource, styleHashSources };
}

function injectCspMeta(html: string, csp: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${csp}">`;
  const headMatch = /<head\b[^>]*>/i.exec(html);
  if (!headMatch) {
    throw new PackageBuildError('the entry HTML has no <head> element to place the CSP <meta> in.');
  }
  const at = headMatch.index + headMatch[0].length;
  return `${html.slice(0, at)}\n${meta}${html.slice(at)}`;
}
