import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './exit-sleep-button.js';

const buttonTrigger = (entity: string) => ({
  type: 'button' as const,
  entity_id: entity,
  gesture: 'single_press' as const,
  correlation_id: 'test-cid',
});

const baseState = {
  'sensor.house_active_mode': { state: 'sleep' },
  'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'off' },
  'input_select.house_active_mode_modifier': { state: 'none' },
};

describe('house:exit_sleep_button', () => {
  it('exits sleep on any non-bedroom non-home-office button', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.hallway_downstairs_button_wall_action'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('exit_sleep');
      expect(result.actions).toEqual([
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal' },
      ]);
    }
  });

  it('exits sleep on bedroom button when bed is not occupied', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.bedroom_button_adam_action'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('exit_sleep');
    }
  });

  it('exits sleep on home office button when not in guest mode', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.home_office_button_wall_action'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('exit_sleep');
    }
  });

  it('returns no_action on bedroom button when bed is occupied', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.bedroom_button_adam_action'),
      state: { ...baseState, 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'on' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'bed_occupied' });
  });

  it('returns no_action on home office button when guest mode is active', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.home_office_button_wall_action'),
      state: { ...baseState, 'input_select.house_active_mode_modifier': { state: 'guest' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'guest_mode_active' });
  });

  it('returns no_action when house is not in sleep mode', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.hallway_downstairs_button_wall_action'),
      state: { ...baseState, 'sensor.house_active_mode': { state: 'normal' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'not_in_sleep_mode' });
  });

  it('aborts when house mode is unavailable', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.hallway_downstairs_button_wall_action'),
      state: { ...baseState, 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('house_mode_unavailable') });
  });

  it('aborts when bed sensor is unavailable for bedroom button', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.bedroom_button_adam_action'),
      state: { ...baseState, 'binary_sensor.bedroom_sensor_bed_occupancy': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('bed_sensor_unavailable') });
  });

  it('aborts when modifier is unavailable for home office button', () => {
    const result = testAutomation(automation, {
      event: buttonTrigger('sensor.home_office_button_wall_action'),
      state: { ...baseState, 'input_select.house_active_mode_modifier': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('modifier_unavailable') });
  });
});
