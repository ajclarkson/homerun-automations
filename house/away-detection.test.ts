import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './away-detection.js';

const RECENTLY = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const zoneTrigger = {
  type: 'state_changed' as const,
  entity_id: 'zone.home',
  old_state: { entity_id: 'zone.home', state: '1', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'zone.home', state: '0', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const baseState = {
  'zone.home': { state: '0' },
  'sensor.house_active_mode': { state: 'normal' },
  'binary_sensor.external_doors_state': { state: 'off', last_changed: RECENTLY },
};

describe('house:away-detection', () => {
  it('sets away mode when nobody is home and a door changed recently', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: baseState,
    });

    expect(result.decision).toBe('set_away');
    expect(result.reason).toBe('all_left_door_recently');
    expect(result.actions).toEqual([
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away' },
    ]);
  });

  it('does nothing when nobody is home but no door event recently', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: {
        ...baseState,
        'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
      },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('no_door_event');
    expect(result.actions).toHaveLength(0);
  });

  it('sets normal mode when someone returns home and house was away', () => {
    const result = testAutomation(automation, {
      event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
      state: {
        ...baseState,
        'zone.home': { state: '1' },
        'sensor.house_active_mode': { state: 'away' },
      },
    });

    expect(result.decision).toBe('set_normal');
    expect(result.reason).toBe('someone_returned');
    expect(result.actions).toEqual([
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal' },
    ]);
  });

  it('does nothing when someone is home and house is already normal', () => {
    const result = testAutomation(automation, {
      event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
      state: { ...baseState, 'zone.home': { state: '1' } },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_in_away_mode');
    expect(result.actions).toHaveLength(0);
  });

  it('does not override vacation or sleep mode on arrival', () => {
    for (const mode of ['vacation', 'sleep']) {
      const result = testAutomation(automation, {
        event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
        state: {
          ...baseState,
          'zone.home': { state: '1' },
          'sensor.house_active_mode': { state: mode },
        },
      });

      expect(result.decision).toBe('no_action');
      expect(result.actions).toHaveLength(0);
    }
  });

  it('aborts when zone.home is unavailable', () => {
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: { ...baseState, 'zone.home': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/zone_home_unavailable/);
  });

  it('aborts when house mode is missing', () => {
    const { 'sensor.house_active_mode': _removed, ...stateWithoutMode } = baseState;
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: stateWithoutMode,
    });

    expect(result.reason).toBe('house_mode_unavailable');
  });

  it('aborts when doors entity is missing', () => {
    const { 'binary_sensor.external_doors_state': _removed, ...stateWithoutDoors } = baseState;
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: stateWithoutDoors,
    });

    expect(result.reason).toBe('doors_entity_missing');
  });
});
