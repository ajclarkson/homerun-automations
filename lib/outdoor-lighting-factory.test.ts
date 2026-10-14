import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import { makeOutdoorLightingAutomation } from './outdoor-lighting-factory.js';

const LOCATION = 'test_garden';
const ON_SCENE = `scene.${LOCATION}_all`;
const OFF_SCENE = `scene.${LOCATION}_off`;

const automation = makeOutdoorLightingAutomation({ location: LOCATION });

// On scene carries scene_order_1, off scene carries scene_control_off — both in this area.
// Another area's scenes carry the same labels, to prove discovery is area-scoped.
function makeHa(opts: { omit?: 'on' | 'off' } = {}): Partial<HAContext> {
  const area = [
    ...(opts.omit === 'on' ? [] : [ON_SCENE]),
    ...(opts.omit === 'off' ? [] : [OFF_SCENE]),
  ];
  const labelMap: Record<string, string[]> = {
    scene_order_1: ['scene.other_garden_all', ON_SCENE],
    scene_control_off: ['scene.other_garden_off', OFF_SCENE],
  };
  return {
    entitiesByArea: (a) => (a === LOCATION ? area : ['scene.other_garden_all', 'scene.other_garden_off']),
    entitiesByLabel: (label) => labelMap[label] ?? [],
  };
}

const baseState = {
  [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' },
  'sun.sun': { state: 'above_horizon' },
  'sensor.house_active_mode': { state: 'normal' },
};

function sunEvent(to: 'below_horizon' | 'above_horizon') {
  const from = to === 'below_horizon' ? 'above_horizon' : 'below_horizon';
  return {
    type: 'state_changed' as const,
    entity_id: 'sun.sun',
    old_state: { entity_id: 'sun.sun', state: from, attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: 'sun.sun', state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

const sunsetEvent = sunEvent('below_horizon');
const sunriseEvent = sunEvent('above_horizon');
const scheduleOffEvent = { type: 'schedule' as const, cron: '0 22 * * *', correlation_id: 'test-cid' };
const onStartEvent = { type: 'on_start' as const, correlation_id: 'test-cid' };

function houseModeEvent(to: string) {
  return {
    type: 'state_changed' as const,
    entity_id: 'sensor.house_active_mode',
    old_state: { entity_id: 'sensor.house_active_mode', state: 'normal', attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: 'sensor.house_active_mode', state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

type AnyEvent = typeof sunsetEvent | typeof scheduleOffEvent | typeof onStartEvent | ReturnType<typeof houseModeEvent>;

function run(event: AnyEvent, overrideState: Record<string, { state: string }> = {}) {
  return testAutomation(automation, { event, state: { ...baseState, ...overrideState }, ha: makeHa() });
}

const dark = { 'sun.sun': { state: 'below_horizon' } };
const light = { 'sun.sun': { state: 'above_horizon' } };
const disabled = { [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } };

const expectScene = (actions: unknown[], entity_id: string) =>
  expect(actions).toEqual([expect.objectContaining({ service: 'turn_on', target: { entity_id } })]);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-07T20:00:00.000Z')); // 20:00 — inside the evening window
});

afterEach(() => vi.useRealTimers());

describe('outdoor lighting', () => {
  describe('at sunset', () => {
    it('turns the garden on when the evening window is still open', () => {
      const result = run(sunsetEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'sunset' });
      expectScene(result.actions, ON_SCENE);
    });

    it('stays off when sunset falls at or after 22:00', () => {
      vi.setSystemTime(new Date('2026-01-07T22:00:00.000Z'));
      const result = run(sunsetEvent, dark);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'no_matching_rule' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('end of the evening', () => {
    it('turns the garden off at 22:00', () => {
      vi.setSystemTime(new Date('2026-01-07T22:00:00.000Z'));
      const result = run(scheduleOffEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'schedule_off' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('turns the garden off at sunrise in case anything was left on overnight', () => {
      vi.setSystemTime(new Date('2026-01-08T08:00:00.000Z'));
      const result = run(sunriseEvent, light);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'sunrise' });
      expectScene(result.actions, OFF_SCENE);
    });
  });

  describe('when the house goes to sleep', () => {
    it('turns the garden off even though the evening window is still open', () => {
      const result = run(houseModeEvent('sleep'), { ...dark, 'sensor.house_active_mode': { state: 'sleep' } });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'house_sleep_mode' });
      expectScene(result.actions, OFF_SCENE);
    });
  });

  describe('after a restart', () => {
    it('turns the garden on if it is dark and before 22:00', () => {
      const result = run(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'startup_sync' });
      expectScene(result.actions, ON_SCENE);
    });

    it('turns the garden off if it is daytime', () => {
      const result = run(onStartEvent, light);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('turns the garden off if it is dark but past 22:00', () => {
      vi.setSystemTime(new Date('2026-01-07T22:30:00.000Z'));
      const result = run(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });
  });

  describe('when automatic lights are switched off for the garden', () => {
    it.each([
      ['sunset', sunsetEvent, dark],
      ['22:00', scheduleOffEvent, dark],
      ['sunrise', sunriseEvent, light],
      ['sleep mode', houseModeEvent('sleep'), dark],
      ['restart', onStartEvent, dark],
    ] as const)('leaves the lights alone at %s', (_name, event, sun) => {
      const result = run(event, { ...sun, ...disabled });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([]);
    });

    it('treats a missing toggle helper as switched off rather than acting', () => {
      const { [`input_boolean.${LOCATION}_automation_lights_enabled`]: _, ...stateWithoutToggle } = baseState;
      const result = testAutomation(automation, { event: sunsetEvent, state: { ...stateWithoutToggle, ...dark }, ha: makeHa() });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
    });
  });

  describe('scene discovery', () => {
    it("uses only this garden's scenes, ignoring identically-labelled scenes in other areas", () => {
      const result = run(sunsetEvent, dark);
      expectScene(result.actions, ON_SCENE);
    });

    it('aborts when the garden has no on scene configured', () => {
      const result = testAbort(automation, { event: sunsetEvent, state: { ...baseState, ...dark }, ha: makeHa({ omit: 'on' }) });
      expect(result.reason).toEqual(expect.stringContaining('no_on_scene_configured'));
    });

    it('aborts when the garden has no off scene configured', () => {
      const result = testAbort(automation, { event: scheduleOffEvent, state: { ...baseState, ...dark }, ha: makeHa({ omit: 'off' }) });
      expect(result.reason).toEqual(expect.stringContaining('no_off_scene_configured'));
    });
  });
});
