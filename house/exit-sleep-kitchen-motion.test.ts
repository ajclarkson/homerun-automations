import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './exit-sleep-kitchen-motion.js';

const kitchenOccupiedTrigger = {
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.kitchen_occupied',
  old_state: { entity_id: 'binary_sensor.kitchen_occupied', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.kitchen_occupied', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};

// Morning window: 05:00 (inclusive) to 10:00 (exclusive)
const baseState = {
  'sensor.house_active_mode': { state: 'sleep' },
  'input_number.house_automation_exit_sleep_earliest_hour': { state: '5' },
  'input_number.house_automation_exit_sleep_latest_hour': { state: '10' },
};

function atHour(hour: number) {
  vi.setSystemTime(new Date(2026, 0, 1, hour, 0, 0));
}

describe('house:exit_sleep_kitchen_motion', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('exits sleep mode when kitchen occupancy is detected during the morning window', () => {
    atHour(7);
    const result = testAutomation(automation, {
      event: kitchenOccupiedTrigger,
      state: baseState,
    });
    expect(result.decision).toBe('exit_sleep');
    expect(result.reason).toBe('kitchen_motion_detected');
    expect(result.actions).toEqual([
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('exits sleep mode right at the start of the morning window', () => {
    atHour(5);
    const result = testAutomation(automation, { event: kitchenOccupiedTrigger, state: baseState });
    expect(result.decision).toBe('exit_sleep');
  });

  it('returns no_action when house is not in sleep mode', () => {
    atHour(7);
    const result = testAutomation(automation, {
      event: kitchenOccupiedTrigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'normal' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'not_in_sleep_mode' });
  });

  it('does not exit sleep mode for kitchen motion from a late-night arrival home', () => {
    atHour(23);
    const result = testAutomation(automation, { event: kitchenOccupiedTrigger, state: baseState });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'outside_morning_window' });
  });

  it('does not exit sleep mode for kitchen motion in the middle of the night', () => {
    atHour(2);
    const result = testAutomation(automation, { event: kitchenOccupiedTrigger, state: baseState });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'outside_morning_window' });
  });

  it('does not exit sleep mode right at the end of the morning window', () => {
    atHour(10);
    const result = testAutomation(automation, { event: kitchenOccupiedTrigger, state: baseState });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'outside_morning_window' });
  });

  it('aborts when house mode is unavailable', () => {
    atHour(7);
    const result = testAbort(automation, {
      event: kitchenOccupiedTrigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('house_mode_unavailable'));
  });

  it('aborts when the morning window bounds are unavailable', () => {
    atHour(7);
    const result = testAbort(automation, {
      event: kitchenOccupiedTrigger,
      state: { ...baseState, 'input_number.house_automation_exit_sleep_earliest_hour': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('sensor_unavailable:earliestHour'));
  });
});
