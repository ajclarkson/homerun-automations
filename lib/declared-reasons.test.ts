import { describe, it, expect } from 'vitest';
import type { DeclaredDecision } from '@ajclarkson/homerun';
import { LIGHTING_REASONS } from './lighting-controller-factory.js';
import { OCCUPANCY_REASONS } from './occupancy-controller-factory.js';
import { OUTDOOR_LIGHTING_REASONS } from './outdoor-lighting-factory.js';
import { THEME_CALENDAR_REASONS } from './theme-calendar.js';
import { HEATING_REASONS } from './heating-controller-factory.js';
import { SONOS_REASONS } from './sonos-controller-factory.js';
import { PORCH_LIGHT_REASONS } from './porch-light-factory.js';
import { THEME_EFFECTS_REASONS } from './theme-effects-factory.js';

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

  it('rejects an undeclared reason in the heating, sonos, porch and theme effects tables', () => {
    // @ts-expect-error 'house_mode_guest' is not a heating reason; house mode names are one reason per mode
    const a: DeclaredDecision<typeof HEATING_REASONS> = { decision: 'no_action', reason: 'house_mode_guest', actions: [] };
    // @ts-expect-error not a sonos reason
    const b: DeclaredDecision<typeof SONOS_REASONS> = { decision: 'no_action', reason: 'dynamic', actions: [] };
    // @ts-expect-error not a porch light reason
    const c: DeclaredDecision<typeof PORCH_LIGHT_REASONS> = { decision: 'no_action', reason: 'look_unreadable:porch_xy_missing', actions: [] };
    // @ts-expect-error not a theme effects reason
    const d: DeclaredDecision<typeof THEME_EFFECTS_REASONS> = { decision: 'no_action', reason: 'dynamic', actions: [] };
    expect([a, b, c, d]).toHaveLength(4);
  });

  it('rejects a heating mode change that leaves out its mode fact', () => {
    // @ts-expect-error schedule declares mode
    const bad: DeclaredDecision<typeof HEATING_REASONS> = { decision: 'set_mode', reason: 'schedule', actions: [] };
    expect(bad.reason).toBe('schedule');
  });

  it('rejects the porch look problem folded into the reason instead of the fact', () => {
    // @ts-expect-error look_unreadable declares problem
    const bad: DeclaredDecision<typeof PORCH_LIGHT_REASONS> = { decision: 'no_action', reason: 'look_unreadable', actions: [] };
    expect(bad.reason).toBe('look_unreadable');
  });

  it('accepts a declared reason with exactly its facts', () => {
    const ok: DeclaredDecision<typeof LIGHTING_REASONS> = { decision: 'no_action', reason: 'lux_high', facts: { lux: 85, lux_threshold: 40 }, actions: [] };
    expect(ok.facts).toEqual({ lux: 85, lux_threshold: 40 });
  });
});
