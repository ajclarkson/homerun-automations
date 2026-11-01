import { describe, it, expect } from 'vitest';
import { isSceneActivation } from './scene-activation.js';

const EARLIER = '2026-10-16T17:44:56.718279+00:00';
const NOW = '2026-10-31T17:00:00.000000+00:00';

describe('telling a scene activation from a scene reload', () => {
  it('counts a scene moving to a new activation time', () => {
    expect(isSceneActivation(EARLIER, NOW)).toBe(true);
  });

  it("counts a scene's first ever activation", () => {
    expect(isSceneActivation('unknown', NOW)).toBe(true);
  });

  it('ignores a reload restoring the previous activation time after unavailable', () => {
    expect(isSceneActivation('unavailable', EARLIER)).toBe(false);
  });

  it('ignores a scene with no previous state (newly loaded)', () => {
    expect(isSceneActivation(undefined, EARLIER)).toBe(false);
  });

  it.each(['unavailable', 'unknown'])('ignores a scene going %s', (s) => {
    expect(isSceneActivation(EARLIER, s)).toBe(false);
  });
});
