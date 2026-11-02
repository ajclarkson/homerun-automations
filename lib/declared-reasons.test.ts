import { describe, it, expect } from 'vitest';
import type { DeclaredDecision } from '@ajclarkson/homerun';
import { LIGHTING_REASONS } from './lighting-controller-factory.js';
import { OCCUPANCY_REASONS } from './occupancy-controller-factory.js';
import { OUTDOOR_LIGHTING_REASONS } from './outdoor-lighting-factory.js';
import { THEME_CALENDAR_REASONS } from './theme-calendar.js';

// These are compile-time checks: `npm run typecheck` fails if a @ts-expect-error stops erroring.
// The runtime assertions only keep the file a valid test.
describe('declared reasons are enforced when the code is compiled', () => {
  it('rejects a reason the lighting controller never declared', () => {
    // @ts-expect-error 'lux_medium' is not a declared lighting reason
    const bad: DeclaredDecision<typeof LIGHTING_REASONS> = { decision: 'no_action', reason: 'lux_medium', actions: [] };
    expect(bad.reason).toBe('lux_medium');
  });

  it('rejects a declared reason that leaves out its facts', () => {
    // @ts-expect-error lux_high declares lux and lux_threshold
    const bad: DeclaredDecision<typeof LIGHTING_REASONS> = { decision: 'no_action', reason: 'lux_high', actions: [] };
    expect(bad.reason).toBe('lux_high');
  });

  it('rejects facts on a reason that declares none', () => {
    // @ts-expect-error already_on declares no facts
    const bad: DeclaredDecision<typeof LIGHTING_REASONS> = { decision: 'no_action', reason: 'already_on', facts: { lux: 1 }, actions: [] };
    expect(bad.reason).toBe('already_on');
  });

  it('rejects an undeclared reason in the occupancy, outdoor lighting and theme calendar tables', () => {
    // @ts-expect-error not an occupancy reason
    const a: DeclaredDecision<typeof OCCUPANCY_REASONS> = { decision: 'no_change', reason: 'dynamic', actions: [] };
    // @ts-expect-error not an outdoor lighting reason
    const b: DeclaredDecision<typeof OUTDOOR_LIGHTING_REASONS> = { decision: 'no_action', reason: 'dynamic', actions: [] };
    // @ts-expect-error not a theme calendar reason
    const c: DeclaredDecision<typeof THEME_CALENDAR_REASONS> = { decision: 'no_action', reason: 'dynamic', actions: [] };
    expect([a, b, c]).toHaveLength(3);
  });

  it('accepts a declared reason with exactly its facts', () => {
    const ok: DeclaredDecision<typeof LIGHTING_REASONS> = { decision: 'no_action', reason: 'lux_high', facts: { lux: 85, lux_threshold: 40 }, actions: [] };
    expect(ok.facts).toEqual({ lux: 85, lux_threshold: 40 });
  });
});
