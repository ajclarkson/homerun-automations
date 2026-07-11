import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './trv-actuation.js';

const activeHeatingTrigger = (room: string, mode: string) => ({
  type: 'state_changed' as const,
  entity_id: `sensor.${room}_active_heating`,
  old_state: { entity_id: `sensor.${room}_active_heating`, state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `sensor.${room}_active_heating`, state: mode,  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'input_number.global_temperature_comfort':        { state: '20' },
  'input_number.global_temperature_baseline_day':   { state: '18' },
  'input_number.global_temperature_baseline_night': { state: '16' },
  'input_number.global_temperature_minimum':        { state: '5' },
  'sensor.parlour_active_heating':            { state: 'comfort' },
  'sensor.kitchen_active_heating':            { state: 'baseline_day' },
  'sensor.hallway_downstairs_active_heating': { state: 'baseline_night' },
  'sensor.bedroom_active_heating':            { state: 'comfort' },
  'sensor.bathroom_active_heating':           { state: 'minimum' },
  'sensor.home_office_active_heating':        { state: 'off' },
};

describe('house:trv_actuation', () => {
  it('sets temperature for a room in comfort mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'comfort'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('set_trvs');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'climate',
        service: 'set_temperature',
        target: { entity_id: 'climate.parlour_trv' },
        data: { hvac_mode: 'heat', temperature: 20 },
      }]);
    }
  });

  it('sets hvac_mode off for a room in off mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('home_office', 'off'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'climate',
        service: 'set_hvac_mode',
        target: { entity_id: 'climate.home_office_trv' },
        data: { hvac_mode: 'off' },
      }]);
    }
  });

  it('reads temperature from global helpers', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('kitchen', 'baseline_day'),
      state: { ...baseState, 'input_number.global_temperature_baseline_day': { state: '17.5' } },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.actions[0]).toMatchObject({ data: { temperature: 17.5 } });
    }
  });

  it('skips rooms with unavailable mode', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('parlour', 'unavailable'),
      state: { ...baseState, 'sensor.parlour_active_heating': { state: 'unavailable' } },
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('no_action');
      expect(result.actions).toHaveLength(0);
    }
  });

  it('uses hallway_downstairs TRV entity', () => {
    const result = testAutomation(automation, {
      event: activeHeatingTrigger('hallway_downstairs', 'baseline_night'),
      state: baseState,
    });
    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.actions[0]).toMatchObject({
        target: { entity_id: 'climate.hallway_downstairs_trv' },
        data: { temperature: 16 },
      });
    }
  });
});
