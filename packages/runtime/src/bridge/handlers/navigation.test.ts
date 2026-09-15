import { describe, expect, it } from 'vitest';
import { createNavigationHandlers } from './navigation';

describe('createNavigationHandlers', () => {
  it('exposes a close method that returns undefined', () => {
    const handlers = createNavigationHandlers();
    expect(handlers.close?.(undefined, { sandbox: {} as never })).toBeUndefined();
  });
});
