import { describe, expect, it } from 'vitest';
import { CORE_PACKAGE } from './index.js';

// Placeholder test to prove the Vitest pipeline runs on the empty scaffold (Phase 0).
describe('core scaffold', () => {
  it('exposes the package marker', () => {
    expect(CORE_PACKAGE).toBe('@free-gift-engine/core');
  });
});
