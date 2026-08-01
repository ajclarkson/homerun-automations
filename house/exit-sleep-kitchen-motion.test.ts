import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './exit-sleep-kitchen-motion.js';

const kitchenOccupiedTrigger = {
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.kitchen_occupied',
  new_state: { state: 'on' },
  correlation_id: 'test-cid',
};

const baseState = {
  'sensor.house_active_mode': { state: 'sleep' },
};

describe('house:exit_sleep_kitchen_motion', () => {
  it('exits sleep mode when kitchen occupancy is detected during sleep mode', () => {
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

  it('returns no_action when house is not in sleep mode', () => {
    const result = testAutomation(automation, {
      event: kitchenOccupiedTrigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'normal' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'not_in_sleep_mode' });
  });

  it('aborts when house mode is unavailable', () => {
    const result = testAbort(automation, {
      event: kitchenOccupiedTrigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('house_mode_unavailable'));
  });
});
