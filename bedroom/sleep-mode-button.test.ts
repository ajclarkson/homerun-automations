import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './sleep-mode-button.js';

const holdTrigger = (entity: string) => ({
  type: 'state_changed' as const,
  entity_id: entity,
  old_state: { entity_id: entity, state: '', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state: 'hold', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'on' },
  'sensor.house_active_mode': { state: 'normal' },
};

describe('bedroom:sleep_mode_button', () => {
  it('sets sleep mode on adam button hold when bed is occupied', () => {
    const result = testAutomation(automation, {
      event: holdTrigger('sensor.bedroom_button_adam_action'),
      state: baseState,
    });
    expect(result.decision).toBe('set_sleep');
    expect(result.actions).toEqual([
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep' },
    ]);
  });

  it('sets sleep mode on wall button hold when bed is occupied', () => {
    const result = testAutomation(automation, {
      event: holdTrigger('sensor.bedroom_button_wall_action'),
      state: baseState,
    });
    expect(result.decision).toBe('set_sleep');
  });

  it('aborts when bed is not occupied', () => {
    const result = testAutomation(automation, {
      event: holdTrigger('sensor.bedroom_button_adam_action'),
      state: { ...baseState, 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'off' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('bed_not_occupied') });
  });

  it('aborts when already in sleep mode', () => {
    const result = testAutomation(automation, {
      event: holdTrigger('sensor.bedroom_button_adam_action'),
      state: { ...baseState, 'sensor.house_active_mode': { state: 'sleep' } },
    });
    expect(result).toMatchObject({ abort: true, reason: 'already_in_sleep_mode' });
  });

  it('aborts when house mode is unavailable', () => {
    const result = testAutomation(automation, {
      event: holdTrigger('sensor.bedroom_button_adam_action'),
      state: { ...baseState, 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('house_mode_unavailable') });
  });
});
