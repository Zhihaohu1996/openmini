import { describe, expect, it } from 'vitest';
import { BridgeInvalidParamsError } from '../errors';
import { createStorageHandlers } from './storage';

describe('createStorageHandlers', () => {
  it('returns null for a key that was never set', () => {
    const handlers = createStorageHandlers();
    expect(handlers.get?.({ key: 'missing' }, { sandbox: {} as never })).toBe(null);
  });

  it('round-trips a value through set then get', () => {
    const handlers = createStorageHandlers();
    handlers.set?.({ key: 'a', value: 'hello' }, { sandbox: {} as never });
    expect(handlers.get?.({ key: 'a' }, { sandbox: {} as never })).toBe('hello');
  });

  it('scopes storage to one handler instance (a fresh instance starts empty)', () => {
    const handlersA = createStorageHandlers();
    handlersA.set?.({ key: 'a', value: 'x' }, { sandbox: {} as never });
    const handlersB = createStorageHandlers();
    expect(handlersB.get?.({ key: 'a' }, { sandbox: {} as never })).toBe(null);
  });

  it.each([[undefined], [null], [{}], [{ key: 42 }], [{ key: '' }]])(
    'get rejects malformed params %#',
    (params) => {
      const handlers = createStorageHandlers();
      expect(() => handlers.get?.(params, { sandbox: {} as never })).toThrow(BridgeInvalidParamsError);
    },
  );

  it.each([[{ key: 'a' }], [{ key: 'a', value: 42 }]])('set rejects malformed params %#', (params) => {
    const handlers = createStorageHandlers();
    expect(() => handlers.set?.(params, { sandbox: {} as never })).toThrow(BridgeInvalidParamsError);
  });
});
