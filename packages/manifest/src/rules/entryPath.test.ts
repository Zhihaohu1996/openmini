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

  it('rejects an absolute filesystem path (Windows)', () => {
    expect(checkEntryPath('C:\\x', 'entry')).toMatchObject({ code: 'INVALID_ENTRY_PATH' });
  });

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
