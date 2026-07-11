import { describe, it, expect } from 'vitest';
import { testAutomation } from 'homerun/testing';
import automation from './bed-occupancy-sync.js';

const trigger = {
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.bedroom_sensor_bed_occupancy',
  old_state: { entity_id: 'binary_sensor.bedroom_sensor_bed_occupancy', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.bedroom_sensor_bed_occupancy', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

describe('bedroom:bed-occupancy-sync', () => {
  it('turns on the sync boolean when bed is occupied', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'on' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('occupied');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_on',
        target: { entity_id: 'input_boolean.hallway_upstairs_bed_occupied_sync' },
      }]);
    }
  });

  it('turns off the sync boolean when bed is unoccupied', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'off' } },
      state: { 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'off' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('unoccupied');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_off',
        target: { entity_id: 'input_boolean.hallway_upstairs_bed_occupied_sync' },
      }]);
    }
  });

  it('aborts when bed sensor is unavailable', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'unavailable' } },
    });

    expect('abort' in result).toBe(true);
    if ('abort' in result) {
      expect(result.reason).toMatch(/bed_sensor_unavailable/);
    }
  });

  it('aborts when bed sensor is unknown', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'unknown' } },
    });

    expect('abort' in result).toBe(true);
  });

  it('aborts when bed sensor is missing from state', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: {},
    });

    expect('abort' in result).toBe(true);
  });
});
