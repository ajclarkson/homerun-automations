import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './overtemp-safety.js';

const tempTrigger = {
  type: 'state_changed' as const,
  entity_id: 'sensor.foreign_office_sensor_climate_temperature',
  old_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '24', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '26', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const heaterTrigger = {
  type: 'state_changed' as const,
  entity_id: 'switch.foreign_office_plug_heater',
  old_state: { entity_id: 'switch.foreign_office_plug_heater', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'switch.foreign_office_plug_heater', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const baseState = {
  'sensor.foreign_office_sensor_climate_temperature': { state: '26' },
  'switch.foreign_office_plug_heater': { state: 'on' },
};

describe('foreign_office:overtemp-safety', () => {
  it('turns off heater when temp exceeds 25 and heater is on (temp trigger)', () => {
    const result = testAutomation(automation, { event: tempTrigger, state: baseState });

    expect(result.decision).toBe('turn_off_heater');
    expect(result.reason).toBe('overtemp_heater_on');
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'switch',
      service: 'turn_off',
      target: { entity_id: 'switch.foreign_office_plug_heater' },
    }]);
  });

  it('turns off heater immediately when heater turns on while already overtemp (heater trigger)', () => {
    const result = testAutomation(automation, { event: heaterTrigger, state: baseState });

    expect(result.decision).toBe('turn_off_heater');
    expect(result.reason).toBe('overtemp_heater_on');
  });

  it('does nothing when heater is off and temp is high', () => {
    const result = testAutomation(automation, {
      event: tempTrigger,
      state: { ...baseState, 'switch.foreign_office_plug_heater': { state: 'off' } },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('overtemp_heater_already_off');
    expect(result.actions).toHaveLength(0);
  });

  it('does nothing when heater is on but temp is at or below 25', () => {
    for (const temp of ['25', '20', '15']) {
      const result = testAutomation(automation, {
        event: tempTrigger,
        state: { ...baseState, 'sensor.foreign_office_sensor_climate_temperature': { state: temp } },
      });

      expect(result.decision).toBe('no_action');
      expect(result.reason).toBe('temp_normal');
      expect(result.actions).toHaveLength(0);
    }
  });

  it('aborts when heater switch is unavailable', () => {
    const result = testAbort(automation, {
      event: tempTrigger,
      state: { ...baseState, 'switch.foreign_office_plug_heater': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/heater_unavailable/);
  });

  it('aborts when temp sensor is unavailable', () => {
    const result = testAbort(automation, {
      event: tempTrigger,
      state: { ...baseState, 'sensor.foreign_office_sensor_climate_temperature': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/temp_unavailable/);
  });

  it('aborts when temp sensor is missing from state', () => {
    const { 'sensor.foreign_office_sensor_climate_temperature': _removed, ...stateWithoutTemp } = baseState;
    testAbort(automation, { event: tempTrigger, state: stateWithoutTemp });
  });
});
