import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './overtemp-safety.js';

const trigger = {
  type: 'state_changed' as const,
  entity_id: 'sensor.foreign_office_sensor_climate_temperature',
  old_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '24', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '26', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const baseState = {
  'sensor.foreign_office_sensor_climate_temperature': { state: '26' },
  'switch.foreign_office_plug_heater': { state: 'on' },
};

describe('foreign-office:overtemp-safety', () => {
  it('turns off heater when temp exceeds 25 and heater is on', () => {
    const result = testAutomation(automation, { event: trigger, state: baseState });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('turn_off_heater');
      expect(result.reason).toBe('overtemp_heater_on');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'switch',
        service: 'turn_off',
        target: { entity_id: 'switch.foreign_office_plug_heater' },
      }]);
    }
  });

  it('does nothing when temp exceeds 25 but heater is already off', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { ...baseState, 'switch.foreign_office_plug_heater': { state: 'off' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('no_action');
      expect(result.reason).toBe('overtemp_heater_already_off');
      expect(result.actions).toHaveLength(0);
    }
  });

  it('does nothing when temp is at or below 25', () => {
    for (const temp of ['25', '20', '15']) {
      const result = testAutomation(automation, {
        event: trigger,
        state: { ...baseState, 'sensor.foreign_office_sensor_climate_temperature': { state: temp } },
      });

      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.decision).toBe('no_action');
        expect(result.reason).toBe('temp_normal');
        expect(result.actions).toHaveLength(0);
      }
    }
  });

  it('aborts when temp sensor is unavailable', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { ...baseState, 'sensor.foreign_office_sensor_climate_temperature': { state: 'unavailable' } },
    });

    expect('abort' in result).toBe(true);
    if ('abort' in result) {
      expect(result.reason).toMatch(/temp_unavailable/);
    }
  });

  it('aborts when temp sensor is missing from state', () => {
    const { 'sensor.foreign_office_sensor_climate_temperature': _removed, ...stateWithoutTemp } = baseState;
    const result = testAutomation(automation, { event: trigger, state: stateWithoutTemp });

    expect('abort' in result).toBe(true);
  });

  it('aborts when heater switch is unavailable', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { ...baseState, 'switch.foreign_office_plug_heater': { state: 'unavailable' } },
    });

    expect('abort' in result).toBe(true);
    if ('abort' in result) {
      expect(result.reason).toMatch(/heater_unavailable/);
    }
  });
});
