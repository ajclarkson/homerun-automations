import { describe, it, expect } from 'vitest';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
import automation from './trv-actuation.js';

const activeHeatingTrigger = (room: string, mode: string) => ({
  type: 'state_changed' as const,
  entity_id: `sensor.${room}_active_heating`,
  old_state: { entity_id: `sensor.${room}_active_heating`, state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `sensor.${room}_active_heating`, state: mode,  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'input_number.global_temperature_comfort':        { state: '20' },
  'input_number.global_temperature_baseline_day':   { state: '18' },
  'input_number.global_temperature_baseline_night': { state: '16' },
  'input_number.global_temperature_minimum':        { state: '5' },
  'sensor.parlour_active_heating':            { state: 'comfort' },
  'sensor.kitchen_active_heating':            { state: 'baseline_day' },
  'sensor.hallway_downstairs_active_heating': { state: 'baseline_night' },
  'sensor.bedroom_active_heating':            { state: 'comfort' },
  'sensor.bathroom_active_heating':           { state: 'minimum' },
  'sensor.home_office_active_heating':        { state: 'off' },
};

describe('house:trv_actuation', () => {
  it('sets temperature for a room in comfort mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'comfort'),
      state: baseState,
    });
    expect(result).toMatchObject({ decision: 'set_trvs', reason: 'trvs_set', outcome: 'ignored' });
    expect(result.facts).toEqual({ rooms: 'parlour', skipped: null, clamped: null });
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'climate',
      service: 'set_temperature',
      target: { entity_id: 'climate.parlour_trv' },
      data: { hvac_mode: 'heat', temperature: 20 },
    }]);
  });

  it('sets hvac_mode off for a room in off mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('home_office', 'off'),
      state: baseState,
    });
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'climate',
      service: 'set_hvac_mode',
      target: { entity_id: 'climate.home_office_trv' },
      data: { hvac_mode: 'off' },
    }]);
  });

  it('reads temperature from global helpers', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('kitchen', 'baseline_day'),
      state: { ...baseState, 'input_number.global_temperature_baseline_day': { state: '17.5' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 17.5 } });
  });

  it('names skipped rooms with an unavailable mode in the facts when startup loads every room', () => {
    const result = testAutomation(automation, {
      event: { type: 'on_start', correlation_id: 'test-cid' },
      state: { ...baseState, 'sensor.parlour_active_heating': { state: 'unavailable' } },
    });
    expect(result.actions.some(a => JSON.stringify(a).includes('parlour'))).toBe(false);
    expect(result.facts).toMatchObject({ rooms: expect.not.stringContaining('parlour') });
  });

  it('declines a room with an unrecognised mode and names it in the facts', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'eco'),
      state: { ...baseState, 'sensor.parlour_active_heating': { state: 'eco' } },
    });
    expect(result.decision).toBe('no_action');
    expect(result.actions).toHaveLength(0);
    expect(result).toMatchObject({ reason: 'trvs_not_set', outcome: 'declined', facts: { skipped: 'parlour' } });
  });

  it('declines a room when its mode helper is unavailable rather than falling back to a default', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'comfort'),
      state: { ...baseState, 'input_number.global_temperature_comfort': { state: 'unavailable' } },
    });
    expect(result.decision).toBe('no_action');
    expect(result.actions).toHaveLength(0);
    expect(result).toMatchObject({ reason: 'trvs_not_set', outcome: 'declined', facts: { skipped: 'parlour' } });
  });

  it('still actuates rooms on other modes when one helper is unavailable', () => {
    const result = testAutomation(automation, {
      event: { type: 'on_start' as const, correlation_id: 'test-cid' },
      state: { ...baseState, 'input_number.global_temperature_comfort': { state: 'unavailable' } },
    });
    // comfort rooms (parlour, bedroom) skipped; other modes still actuated
    expect(result).toMatchObject({ reason: 'trvs_set', outcome: 'ignored' });
    expect(result.facts).toEqual({
      rooms: 'kitchen,hallway_downstairs,bathroom,home_office',
      skipped: 'parlour,bedroom',
      clamped: null,
    });
  });

  it('clamps setpoint to MAX_SETPOINT_C and names the room in the facts when helper value is above the safe range', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'comfort'),
      state: { ...baseState, 'input_number.global_temperature_comfort': { state: '30' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 25 } });
    expect(result.facts).toEqual({ rooms: 'parlour', skipped: null, clamped: 'parlour' });
  });

  it('clamps setpoint to MIN_SETPOINT_C and names the room in the facts when helper value is below the safe range', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'minimum'),
      state: { ...baseState, 'sensor.parlour_active_heating': { state: 'minimum' }, 'input_number.global_temperature_minimum': { state: '1' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 5 } });
    expect(result.facts).toEqual({ rooms: 'parlour', skipped: null, clamped: 'parlour' });
  });

  it('uses hallway_downstairs TRV entity', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('hallway_downstairs', 'baseline_night'),
      state: baseState,
    });
    expect(result.actions[0]).toMatchObject({
      target: { entity_id: 'climate.hallway_downstairs_trv' },
      data: { temperature: 16 },
    });
  });

  describe('an HA reload walks the mode sensor through unavailable and unknown', () => {
    const change = (room: string, from: string, to: string) => ({
      ...activeHeatingTrigger(room, to),
      old_state: { entity_id: `sensor.${room}_active_heating`, state: from, attributes: {}, last_changed: '', last_updated: '' },
    });
    const parlourTrv = (temperature: number) => ({ 'climate.parlour_trv': { state: 'heat', attributes: { temperature } } });

    it.each(['unavailable', 'unknown'])('ignores the run, with no actions and no abort, when the mode becomes %s', to => {
      const result = testAutomation(automation, {
        event: change('parlour', 'comfort', to),
        state: { ...baseState, 'sensor.parlour_active_heating': { state: to } },
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'input_not_valid', outcome: 'ignored' });
      expect(result.actions).toEqual([]);
    });

    it('ignores the step between unavailable and unknown', () => {
      const result = testAutomation(automation, {
        event: change('parlour', 'unavailable', 'unknown'),
        state: { ...baseState, 'sensor.parlour_active_heating': { state: 'unknown' } },
      });
      expect(result.reason).toBe('input_not_valid');
    });

    it('sends nothing when the mode returns to what the TRV already holds', () => {
      const result = testAutomation(automation, {
        event: change('parlour', 'unknown', 'comfort'),
        state: { ...baseState, ...parlourTrv(20) },
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'trvs_already_set', facts: { rooms: 'parlour' } });
      expect(result.actions).toEqual([]);
    });

    it('sends the setpoint once when the mode really changed during the outage', () => {
      const result = testAutomation(automation, {
        event: change('parlour', 'unknown', 'comfort'),
        state: { ...baseState, ...parlourTrv(16) },
      });
      expect(result.actions).toHaveLength(1);
      expect(result.actions[0]).toMatchObject({ service: 'set_temperature', data: { temperature: 20 } });
    });

    it('does not re-send hvac off to a TRV that is already off', () => {
      const result = testAutomation(automation, {
        event: change('home_office', 'unknown', 'off'),
        state: { ...baseState, 'climate.home_office_trv': { state: 'off' } },
      });
      expect(result.actions).toEqual([]);
    });
  });
});
