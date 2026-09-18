import { describe, expect, it } from 'vitest';
import { checkEntryPath } from './entryPath';

describe('checkEntryPath', () => {
  it.each(['index.html', 'assets/index.html', 'a/b/c.js'])(
    'accepts valid relative entry %s',
    (value) => {
      expect(checkEntryPath(value, 'entry')).toBeNull();
    },
  );

  it('rejects an absolute filesystem path (POSIX)', () => {
    expect(checkEntryPath('/etc/x', 'entry')).toMatchObject({ code: 'INVALID_ENTRY_PATH' });
  });

  it.each(['C:\\x', 'C:/x'])(
    'rejects the absolute Windows path %s as a filesystem path, not as a URL',
    (value) => {
      // The drive letter also matches the (now bare-scheme) URL pattern, so
      // this pins the check order that keeps the diagnostic precise.
      expect(checkEntryPath(value, 'entry')).toMatchObject({
        code: 'INVALID_ENTRY_PATH',
        message: expect.stringContaining('absolute filesystem path'),
      });
    },
  );

  it('rejects a root-absolute path', () => {
    expect(checkEntryPath('/index.html', 'entry')).toMatchObject({
      code: 'INVALID_ENTRY_PATH',
      message: expect.stringContaining('root-absolute'),
    });
  });

  it('rejects a URL entry', () => {
    expect(checkEntryPath('https://example.com/index.html', 'entry')).toMatchObject({
      code: 'INVALID_ENTRY_PATH',
      message: expect.stringContaining('URL'),
    });
  });

  it('rejects a file:// URL entry', () => {
    expect(checkEntryPath('file:///index.html', 'entry')).toMatchObject({
      code: 'INVALID_ENTRY_PATH',
      message: expect.stringContaining('URL'),
    });
  });

  it.each(['https:evil.com', 'https:/evil.com', 'data:text/html,x', 'javascript:alert(1)'])(
    'rejects the bare-scheme URL entry %s',
    (value) => {
      // No `//`, but still absolute to the WHATWG parser: such an entry names
      // a document outside the package it is declared in.
      expect(checkEntryPath(value, 'entry')).toMatchObject({
        code: 'INVALID_ENTRY_PATH',
        message: expect.stringContaining('URL'),
      });
    },
  );

  it('rejects path traversal', () => {
    expect(checkEntryPath('../index.html', 'entry')).toMatchObject({
      code: 'INVALID_ENTRY_PATH',
      message: expect.stringContaining('traversal'),
    });
  });

  it('rejects nested path traversal', () => {
    expect(checkEntryPath('a/../../b.html', 'entry')).toMatchObject({
      code: 'INVALID_ENTRY_PATH',
      message: expect.stringContaining('traversal'),
    });
  });

  it('rejects an empty entry', () => {
    expect(checkEntryPath('', 'entry')).toMatchObject({ code: 'INVALID_ENTRY_PATH' });
  });

  it('rejects non-string values', () => {
    expect(checkEntryPath(123, 'entry')).toMatchObject({ code: 'INVALID_TYPE' });
  });
});
