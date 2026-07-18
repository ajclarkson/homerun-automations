import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './window-external.js';

const openingsTrigger = (room: string, open: boolean) => ({
  type: 'state_changed' as const,
  entity_id: `binary_sensor.${room}_external_openings`,
  old_state: { entity_id: `binary_sensor.${room}_external_openings`, state: open ? 'off' : 'on', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `binary_sensor.${room}_external_openings`, state: open ? 'on' : 'off',  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'binary_sensor.parlour_external_openings':            { state: 'off' },
  'binary_sensor.kitchen_external_openings':            { state: 'off' },
  'binary_sensor.hallway_downstairs_external_openings': { state: 'off' },
  'binary_sensor.bedroom_external_openings':            { state: 'off' },
  'binary_sensor.bathroom_external_openings':           { state: 'off' },
  'binary_sensor.home_office_external_openings':        { state: 'off' },
};

describe('house:window_external', () => {
  it('turns on the TRV window switch when opening is open', () => {
    const result = testAutomation(automation, {
      event: openingsTrigger('parlour', true),
      state: { ...baseState, 'binary_sensor.parlour_external_openings': { state: 'on' } },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('sync_window_external');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'switch',
        service: 'turn_on',
        target: { entity_id: 'switch.parlour_trv_window_open_external' },
      }]);
    }
  });

  it('turns off the TRV window switch when opening is closed', () => {
    const result = testAutomation(automation, {
      event: openingsTrigger('bedroom', false),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'switch',
        service: 'turn_off',
        target: { entity_id: 'switch.bedroom_trv_window_open_external' },
      }]);
    }
  });

  it('uses hallway_downstairs entity', () => {
    const result = testAutomation(automation, {
      event: openingsTrigger('hallway_downstairs', true),
      state: { ...baseState, 'binary_sensor.hallway_downstairs_external_openings': { state: 'on' } },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.actions[0]).toMatchObject({
        target: { entity_id: 'switch.hallway_downstairs_trv_window_open_external' },
      });
    }
  });
});
