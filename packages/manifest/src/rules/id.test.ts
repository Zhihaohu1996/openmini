import { describe, expect, it } from 'vitest';
import { checkId } from './id';

describe('checkId', () => {
  it.each(['com.example.restaurant', 'io.openmini.live-commerce', 'dev.company.booking'])(
    'accepts valid id %s',
    (value) => {
      expect(checkId(value, 'id')).toBeNull();
    },
  );

  it('rejects a single segment', () => {
    expect(checkId('com', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects uppercase characters', () => {
    expect(checkId('COM.example.app', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects an empty segment', () => {
    expect(checkId('com..example', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects a segment starting with a hyphen', () => {
    expect(checkId('com.example.-app', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects a segment ending with a hyphen', () => {
    expect(checkId('com.example.app-', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects underscores', () => {
    expect(checkId('com.example.app_', 'id')).toMatchObject({ code: 'INVALID_ID' });
  });

  it('rejects non-string values', () => {
    expect(checkId(42, 'id')).toMatchObject({ code: 'INVALID_TYPE' });
  });
});
