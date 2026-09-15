import { describe, expect, it } from 'vitest';
import { createUserHandlers } from './user';

describe('createUserHandlers', () => {
  it('returns a static stub profile', () => {
    const handlers = createUserHandlers();
    expect(handlers.getProfile?.(undefined, { sandbox: {} as never })).toEqual({ id: null, displayName: null });
  });
});
