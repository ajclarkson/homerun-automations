import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './heating-actuation.js';

const activeHeatingTrigger = (mode: string) => ({
  type: 'state_changed' as const,
  entity_id: 'sensor.foreign_office_active_heating',
  old_state: { entity_id: 'sensor.foreign_office_active_heating', state: 'minimum', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.foreign_office_active_heating', state: mode, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'input_number.global_temperature_comfort':        { state: '20' },
  'input_number.global_temperature_baseline_day':   { state: '18' },
  'input_number.global_temperature_baseline_night': { state: '16' },
  'input_number.global_temperature_minimum':        { state: '5' },
  'sensor.foreign_office_active_heating':           { state: 'comfort' },
};

describe('foreign_office:heating_actuation', () => {
  it('sets the climate setpoint for comfort mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('comfort'),
      state: baseState,
    });
    expect(result.decision).toBe('set_temperature');
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'climate',
      service: 'set_temperature',
      target: { entity_id: 'climate.foreign_office' },
      data: { hvac_mode: 'heat', temperature: 20 },
    }]);
  });

  it('reads the setpoint from the mode-specific global helper', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('baseline_day'),
      state: { ...baseState, 'sensor.foreign_office_active_heating': { state: 'baseline_day' }, 'input_number.global_temperature_baseline_day': { state: '17.5' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 17.5 } });
  });

  it('drops to minimum when the room is unoccupied and the schedule requests it', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('minimum'),
      state: { ...baseState, 'sensor.foreign_office_active_heating': { state: 'minimum' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 5 } });
  });

  it('does nothing when the mode sensor is unavailable', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('unavailable'),
      state: { ...baseState, 'sensor.foreign_office_active_heating': { state: 'unavailable' } },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('mode_unavailable:unavailable');
    expect(result.actions).toHaveLength(0);
  });

  it('does nothing when the mode sensor is missing from state', () => {
    const { 'sensor.foreign_office_active_heating': _removed, ...stateWithoutMode } = baseState;
    const result = testAutomation(automation, {
      event: { type: 'on_start' as const, correlation_id: 'test-cid' },
      state: stateWithoutMode,
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('mode_unavailable:null');
  });

  it('records a named reason for an unrecognised mode rather than falling back to a default', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('eco'),
      state: { ...baseState, 'sensor.foreign_office_active_heating': { state: 'eco' } },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('unknown_mode:eco');
    expect(result.actions).toHaveLength(0);
  });

  it('does nothing with a named reason when the mode helper is unavailable rather than falling back to a default', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('comfort'),
      state: { ...baseState, 'input_number.global_temperature_comfort': { state: 'unavailable' } },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('helper_unavailable:comfort');
    expect(result.actions).toHaveLength(0);
  });

  it('clamps setpoint to MAX_SETPOINT_C and records it in the reason when helper value is above the safe range', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('comfort'),
      state: { ...baseState, 'input_number.global_temperature_comfort': { state: '30' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 25 } });
    expect(result.reason).toContain('clamped_from_30');
  });

  it('clamps setpoint to MIN_SETPOINT_C and records it in the reason when helper value is below the safe range', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('minimum'),
      state: { ...baseState, 'sensor.foreign_office_active_heating': { state: 'minimum' }, 'input_number.global_temperature_minimum': { state: '1' } },
    });
    expect(result.actions[0]).toMatchObject({ data: { temperature: 5 } });
    expect(result.reason).toContain('clamped_from_1');
  });

  it('actuates on startup using the already-resolved mode', () => {
    const result = testAutomation(automation, {
      event: { type: 'on_start' as const, correlation_id: 'test-cid' },
      state: baseState,
    });
    expect(result.decision).toBe('set_temperature');
    expect(result.actions[0]).toMatchObject({ data: { temperature: 20 } });
  });
});
