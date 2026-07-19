import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './sleep-mode-bypass.js';

const doublePressEvent = {
  type: 'button' as const,
  entity_id: 'sensor.bedroom_button_adam_action',
  gesture: 'double_press' as const,
  correlation_id: 'test-cid',
};

const baseState = {
  'sensor.house_active_mode': { state: 'normal' },
};

describe('bedroom:sleep_mode_bypass', () => {
  it('sets sleep mode on double press regardless of bed sensor state', () => {
    const result = testAutomation(automation, {
      event: doublePressEvent,
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('set_sleep_bypass');
      expect(result.actions).toEqual([
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep' },
      ]);
    }
  });

  it('returns no_action when already in sleep mode', () => {
    const result = testAutomation(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'sleep' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'already_in_sleep_mode' });
  });

  it('aborts when house mode is unavailable', () => {
    const result = testAutomation(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('house_mode_unavailable') });
  });

  it('aborts when house mode is unknown', () => {
    const result = testAutomation(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'unknown' } },
    });
    expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('house_mode_unavailable') });
  });
});
