import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './patio-door.js';

const patioDoorTrigger = (open: boolean) => ({
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.parlour_sensor_door_patio_contact',
  old_state: { entity_id: 'binary_sensor.parlour_sensor_door_patio_contact', state: open ? 'off' : 'on', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.parlour_sensor_door_patio_contact', state: open ? 'on' : 'off',  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'binary_sensor.parlour_sensor_door_patio_contact': { state: 'off' },
  'input_boolean.house_heating_enabled':              { state: 'on' },
  'input_boolean.patio_door_heating_suspended':       { state: 'off' },
};

describe('house:patio_door', () => {
  it('suspends heating when door opens and heating is on', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(true),
      state: { ...baseState, 'binary_sensor.parlour_sensor_door_patio_contact': { state: 'on' } },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('suspend');
      expect(result.actions).toEqual([
        { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on',  target: { entity_id: 'input_boolean.patio_door_heating_suspended' } },
        { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_off', target: { entity_id: 'input_boolean.house_heating_enabled' } },
      ]);
    }
  });

  it('restores heating when door closes and was suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: {
        ...baseState,
        'binary_sensor.parlour_sensor_door_patio_contact': { state: 'off' },
        'input_boolean.house_heating_enabled':              { state: 'off' },
        'input_boolean.patio_door_heating_suspended':       { state: 'on' },
      },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('restore');
      expect(result.actions).toEqual([
        { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on',  target: { entity_id: 'input_boolean.house_heating_enabled' } },
        { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_off', target: { entity_id: 'input_boolean.patio_door_heating_suspended' } },
      ]);
    }
  });

  it('does nothing when door opens but heating is already off and not suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(true),
      state: {
        ...baseState,
        'binary_sensor.parlour_sensor_door_patio_contact': { state: 'on' },
        'input_boolean.house_heating_enabled':              { state: 'off' },
      },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('no_action');
      expect(result.reason).toBe('door_open_heating_already_off');
    }
  });

  it('does nothing when door closes and was not suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('no_action');
      expect(result.reason).toBe('door_closed_not_suspended');
    }
  });

  it('aborts when door sensor is unavailable', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(true),
      state: { ...baseState, 'binary_sensor.parlour_sensor_door_patio_contact': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('door_unavailable') });
  });

  it('aborts when heating enabled helper is unavailable', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: { ...baseState, 'input_boolean.house_heating_enabled': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('heating_enabled_unavailable') });
  });

  it('aborts when suspended flag is unavailable', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: { ...baseState, 'input_boolean.patio_door_heating_suspended': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('suspended_flag_unavailable') });
  });
});
