import { describe, it, expect } from 'vitest';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
import occupancy from './occupancy.js';

const SHOWER = 'binary_sensor.bathroom_shower';
const ev = (to: string) => ({
  type: 'state_changed' as const, entity_id: SHOWER,
  old_state: { entity_id: SHOWER, state: 'x', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: SHOWER, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'c',
});
const state = (shower: string) => ({
  'binary_sensor.bathroom_sensor_motion_occupancy': { state: 'off' },
  'input_boolean.bathroom_sensor_motion_enabled': { state: 'on' },
  'binary_sensor.bathroom_occupied': { state: 'on' },
  'binary_sensor.bathroom_occupied_contained': { state: 'off' },
  [SHOWER]: { state: shower },
});
const ha = {
  entitiesByArea: () => [SHOWER, 'binary_sensor.bathroom_sensor_motion_occupancy'],
  entitiesByLabel: (l: string) => (l === 'presence_hold_strong' ? [SHOWER] : []),
};

describe('bathroom occupancy and the shower', () => {
  it('re-evaluates when the shower sensor changes', () => {
    expect(occupancy.triggers).toContainEqual({ type: 'state_changed', entity: SHOWER });
  });
  it('holds the room occupied while water is running (once the hold label is applied)', () => {
    const r = testAutomation(occupancy, { event: ev('on'), state: state('on'), ha });
    expect(r).toMatchObject({ reason: 'evidence_still_present', outcome: 'ignored' });
  });
  it('declines to empty the room when the clear timer fires mid-shower, and says which hold', () => {
    const timer = { type: 'timer_expired' as const, timerKey: 'bathroom:occupied_clear', correlation_id: 'c' };
    const r = testAutomation(occupancy, { event: timer, state: state('on'), ha });
    expect(r).toMatchObject({ decision: 'no_change', reason: 'strong_hold_active', outcome: 'declined', facts: { hold: SHOWER } });
  });
  it('starts the normal clear timer when the shower ends', () => {
    const r = testAutomation(occupancy, { event: ev('off'), state: state('off'), ha });
    expect(r.reason).toBe('normal_clear_timer');
    expect(r.actions).toContainEqual({ type: 'timer.start', timerKey: 'bathroom:occupied_clear', delayMs: 5 * 60_000 });
  });
});
