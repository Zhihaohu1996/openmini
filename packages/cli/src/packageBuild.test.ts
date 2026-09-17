import { buildMiniAppCsp } from '@openmini/shared';
import { describe, expect, it } from 'vitest';
import { PackageBuildError, assembleEntryDocument } from './packageBuild.js';

const SHELL = `<!doctype html>
<html><head><meta charset="utf-8"><title>t</title></head>
<body><h1>hi</h1><script></script></body></html>`;

const SCRIPT = 'console.log("hello");';

function assemble(html: string, script = SCRIPT) {
  return assembleEntryDocument({ html, script });
}

describe('CSP ownership', () => {
  it('generates the policy itself and places it in <head>', () => {
    const result = assemble(SHELL);
    expect(result.html).toContain('<meta http-equiv="Content-Security-Policy"');
    expect(result.html.indexOf('Content-Security-Policy')).toBeLessThan(result.html.indexOf('<body'));
  });

  it('emits exactly the policy the runtime would build — not a copy of it', () => {
    const result = assemble(SHELL);
    expect(result.csp).toBe(buildMiniAppCsp(result.scriptHashSource, result.styleHashSources));
  });

  it('fails closed when the author already declared a CSP, rather than merging', () => {
    const withCsp = SHELL.replace(
      '<title>t</title>',
      `<meta http-equiv="Content-Security-Policy" content="default-src *"><title>t</title>`,
    );
    expect(() => assemble(withCsp)).toThrow(PackageBuildError);
    expect(() => assemble(withCsp)).toThrow(/already declares a Content-Security-Policy/);
  });

  it('emits exactly one policy', () => {
    const html = assemble(SHELL).html;
    expect(html.match(/Content-Security-Policy/g)).toHaveLength(1);
  });
});

describe('hashing', () => {
  it('hashes the bundled script into script-src', () => {
    const result = assemble(SHELL);
    expect(result.scriptHashSource).toMatch(/^sha256-[A-Za-z0-9+/]+=*$/);
    expect(result.csp).toContain(`script-src '${result.scriptHashSource}'`);
  });

  it('changes the script hash when the script changes', () => {
    expect(assemble(SHELL, 'a();').scriptHashSource).not.toBe(assemble(SHELL, 'b();').scriptHashSource);
  });

  it('hashes an inline <style> block into style-src', () => {
    const styled = SHELL.replace('<title>t</title>', '<title>t</title><style>body{color:red}</style>');
    const result = assemble(styled);
    expect(result.styleHashSources).toHaveLength(1);
    expect(result.csp).toContain(`style-src '${result.styleHashSources[0]}'`);
  });

  it('leaves style-src as none when the document has no styles', () => {
    const result = assemble(SHELL);
    expect(result.styleHashSources).toEqual([]);
    expect(result.csp).toContain("style-src 'none'");
  });

  it('inlines the script verbatim, even when it contains $& replacement patterns', () => {
    const tricky = 'const re = "$&$1".replace(/x/, "$&");';
    expect(assemble(SHELL, tricky).html).toContain(tricky);
  });
});

describe('unsupported constructs are rejected at build time', () => {
  it.each([
    ['external script', '<script src="https://cdn.example.com/x.js"></script>', /external <script/],
    ['external stylesheet', '<link rel="stylesheet" href="x.css">', /external stylesheet/],
    ['inline event handler', '<button onclick="go()">go</button>', /inline event handler/],
    ['style attribute', '<p style="color:red">x</p>', /style="\.\.\." attribute/],
    ['img element', '<img src="x.png">', /<img> element/],
    ['iframe element', '<iframe src="x"></iframe>', /<iframe> element/],
    ['object element', '<object data="x"></object>', /<object>\/<embed> element/],
    ['form element', '<form action="/x"></form>', /<form> element/],
    ['base element', '<base href="/">', /<base> element/],
  ])('rejects %s', (_label, snippet, expected) => {
    const html = SHELL.replace('<h1>hi</h1>', snippet);
    expect(() => assemble(html)).toThrow(PackageBuildError);
    expect(() => assemble(html)).toThrow(expected);
  });

  it.each([
    ['eval', 'eval("1+1");', /eval\(\)/],
    ['new Function', 'const f = new Function("return 1");', /new Function/],
    ['dynamic import', 'await import("./x.js");', /dynamic import/],
  ])('rejects %s in the entry script', (_label, script, expected) => {
    expect(() => assemble(SHELL, script)).toThrow(expected);
  });

  it('explains what to do instead, not just that it refused', () => {
    const html = SHELL.replace('<h1>hi</h1>', '<form action="/x"></form>');
    expect(() => assemble(html)).toThrow(/openmini\.network\.fetch/);
  });
});

describe('document requirements', () => {
  it('requires an empty <script></script> placeholder', () => {
    const noPlaceholder = '<!doctype html><html><head></head><body><h1>hi</h1></body></html>';
    expect(() => assemble(noPlaceholder)).toThrow(/placeholder/);
  });

  it('requires a <head> to place the policy in', () => {
    const noHead = '<!doctype html><html><body><script></script></body></html>';
    expect(() => assemble(noHead)).toThrow(/<head>/);
  });
});
