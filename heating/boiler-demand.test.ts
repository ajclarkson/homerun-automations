import { describe, it, expect } from 'vitest';
import { testAutomation, testUnavailable } from '@ajclarkson/homerun/testing';
import automation from './boiler-demand.js';

const heatRequiredTrigger = (room: string) => ({
  type: 'state_changed' as const,
  entity_id: `binary_sensor.${room}_trv_heat_required`,
  old_state: { entity_id: `binary_sensor.${room}_trv_heat_required`, state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `binary_sensor.${room}_trv_heat_required`, state: 'on',  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'input_boolean.house_heating_enabled': { state: 'on' },
  'binary_sensor.parlour_trv_heat_required':            { state: 'off' },
  'binary_sensor.kitchen_trv_heat_required':            { state: 'off' },
  'binary_sensor.hallway_downstairs_trv_heat_required': { state: 'off' },
  'binary_sensor.bedroom_trv_heat_required':            { state: 'off' },
  'binary_sensor.bathroom_trv_heat_required':           { state: 'off' },
  'binary_sensor.home_office_trv_heat_required':        { state: 'off' },
};

describe('house:boiler_demand', () => {
  it('turns boiler on when a room is calling for heat', () => {
    const result = testAutomation(automation, {
      event: heatRequiredTrigger('parlour'),
      state: { ...baseState, 'binary_sensor.parlour_trv_heat_required': { state: 'on' } },
    });
    expect(result.decision).toBe('boiler_on');
    const action = result.actions[0];
    expect(action.type).toBe('mqtt.publish');
    if (action.type === 'mqtt.publish') {
      expect(action.topic).toBe('zigbee2mqtt/boiler_receiver/set');
      expect(JSON.parse(action.payload).occupied_heating_setpoint_heat).toBe(30);
    }
  });

  it('turns boiler off when no rooms are calling', () => {
    const result = testAutomation(automation, {
      event: heatRequiredTrigger('parlour'),
      state: baseState,
    });
    expect(result.decision).toBe('boiler_off');
    expect(result.reason).toBe('no_demand');
    const action = result.actions[0];
    if (action.type === 'mqtt.publish') {
      expect(JSON.parse(action.payload).occupied_heating_setpoint_heat).toBe(5);
    }
  });

  it('turns boiler off when heating is disabled even with demand', () => {
    const result = testAutomation(automation, {
      event: heatRequiredTrigger('parlour'),
      state: {
        ...baseState,
        'input_boolean.house_heating_enabled': { state: 'off' },
        'binary_sensor.parlour_trv_heat_required': { state: 'on' },
      },
    });
    expect(result.decision).toBe('boiler_off');
    expect(result.reason).toBe('heating_disabled');
  });

  it('includes all calling rooms in the reason', () => {
    const result = testAutomation(automation, {
      event: heatRequiredTrigger('parlour'),
      state: {
        ...baseState,
        'binary_sensor.parlour_trv_heat_required': { state: 'on' },
        'binary_sensor.bedroom_trv_heat_required': { state: 'on' },
      },
    });
    expect(result.reason).toContain('parlour');
    expect(result.reason).toContain('bedroom');
  });

  it('aborts when heating enabled state is unavailable', () => {
    const entityId = testUnavailable(automation, {
      event: heatRequiredTrigger('parlour'),
      state: { ...baseState, 'input_boolean.house_heating_enabled': { state: 'unavailable' } },
    });
    expect(entityId).toBe('input_boolean.house_heating_enabled');
  });
});
