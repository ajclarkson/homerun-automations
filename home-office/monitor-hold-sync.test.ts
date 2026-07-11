import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './monitor-hold-sync.js';

const trigger = {
  type: 'state_changed' as const,
  entity_id: 'sensor.home_office_plug_monitor_power',
  old_state: { entity_id: 'sensor.home_office_plug_monitor_power', state: '0', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.home_office_plug_monitor_power', state: '45', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const MQTT_ACTION = (payload: 'ON' | 'OFF') => ({
  type: 'mqtt.publish',
  topic: 'home_office/monitor/state',
  payload,
  retain: true,
});

describe('home_office:monitor-hold-sync', () => {
  it('publishes ON when power exceeds threshold', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'sensor.home_office_plug_monitor_power': { state: '45' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('monitor_on');
      expect(result.actions).toEqual([MQTT_ACTION('ON')]);
    }
  });

  it('publishes ON when power is just above threshold', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'sensor.home_office_plug_monitor_power': { state: '5.1' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('monitor_on');
      expect(result.actions).toEqual([MQTT_ACTION('ON')]);
    }
  });

  it('publishes OFF when power is at or below threshold', () => {
    for (const power of ['5', '0', '1.2']) {
      const result = testAutomation(automation, {
        event: { ...trigger, new_state: { ...trigger.new_state, state: power } },
        state: { 'sensor.home_office_plug_monitor_power': { state: power } },
      });

      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.decision).toBe('monitor_off');
        expect(result.actions).toEqual([MQTT_ACTION('OFF')]);
      }
    }
  });

  it('aborts when power sensor is unavailable', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'sensor.home_office_plug_monitor_power': { state: 'unavailable' } },
    });

    expect('abort' in result).toBe(true);
    if ('abort' in result) {
      expect(result.reason).toMatch(/power_unavailable/);
    }
  });

  it('aborts when power sensor is missing from state', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: {},
    });

    expect('abort' in result).toBe(true);
  });
});
