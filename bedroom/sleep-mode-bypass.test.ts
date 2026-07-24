import { describe, it, expect } from 'vitest';
import { testAutomation, testUnavailable } from '@ajclarkson/homerun/testing';
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
    expect(result.decision).toBe('set_sleep_bypass');
    expect(result.actions).toEqual([
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('returns no_action when already in sleep mode', () => {
    const result = testAutomation(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'sleep' } },
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'already_in_sleep_mode' });
  });

  it('aborts when house mode is unavailable', () => {
    const entityId = testUnavailable(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'unavailable' } },
    });
    expect(entityId).toBe('sensor.house_active_mode');
  });

  it('aborts when house mode is unknown', () => {
    const entityId = testUnavailable(automation, {
      event: doublePressEvent,
      state: { 'sensor.house_active_mode': { state: 'unknown' } },
    });
    expect(entityId).toBe('sensor.house_active_mode');
  });
});
