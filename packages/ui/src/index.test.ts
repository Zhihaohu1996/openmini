import { describe, expect, it } from 'vitest';
import { OPENMINI_UI_VERSION, Placeholder } from './index';

describe('@openmini/ui', () => {
  it('exposes a version string', () => {
    expect(OPENMINI_UI_VERSION).toBe('0.1.0');
  });

  it('exports the Placeholder component', () => {
    expect(typeof Placeholder).toBe('function');
  });
});
