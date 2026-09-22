import { describe, expect, it } from 'vitest';
import { MAX_ID_LENGTH } from '../constants';
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

/**
 * W8. `name` has been length-bounded since Phase 2 and `id` had not, which
 * is the wrong way round: `name` is a label, while `id` is a key. It scopes
 * storage, it is bound into a package signature, and it lands in logs and
 * error text — so an unbounded value there is a way to consume space or
 * flood a log from one manifest field.
 */
describe('id length bound', () => {
  const segment = (length: number) => `com.${'a'.repeat(length - 4)}`;

  it('accepts an id of exactly the maximum length', () => {
    const id = segment(MAX_ID_LENGTH);
    expect(id).toHaveLength(MAX_ID_LENGTH);
    expect(checkId(id, 'id')).toBeNull();
  });

  it('rejects an id one character over the maximum', () => {
    const id = segment(MAX_ID_LENGTH + 1);
    expect(checkId(id, 'id')).toMatchObject({
      path: 'id',
      code: 'INVALID_ID',
      message: `must be at most ${MAX_ID_LENGTH} characters`,
    });
  });

  it('reports length rather than shape for a long id that is otherwise valid', () => {
    // The pattern constrains characters, not size, so a 10k id matches it
    // perfectly well. The more useful diagnostic is the one about length.
    const issue = checkId(segment(10_000), 'id');
    expect(issue?.message).toMatch(/at most/);
  });

  it('reports length, not shape, for an id that breaks both rules', () => {
    // Length is checked first, so this documents which message wins: an id
    // that breaks both rules is reported as too long, since that is the one
    // an author has to fix before the other can even be assessed.
    expect(checkId('A'.repeat(MAX_ID_LENGTH + 1), 'id')?.message).toMatch(/at most/);
  });
});
