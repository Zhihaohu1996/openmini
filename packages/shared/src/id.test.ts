import { describe, expect, it } from 'vitest';
import { generateRandomId } from './id';

describe('generateRandomId', () => {
  it('produces distinct ids across calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => generateRandomId()));
    expect(ids.size).toBe(20);
  });

  it('produces a non-empty string', () => {
    expect(typeof generateRandomId()).toBe('string');
    expect(generateRandomId().length).toBeGreaterThan(0);
  });
});
