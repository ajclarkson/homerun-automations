import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automations from './room-temp-feed.js';

const stateChangeTrigger = (entity: string, state: string) => ({
  type: 'state_changed' as const,
  entity_id: entity,
  old_state: { entity_id: entity, state: '2000', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const scheduleTrigger = {
  type: 'schedule' as const,
  cron: '*/15 * * * *',
  correlation_id: 'test-cid',
};

describe('room-temp-feed', () => {
  it('exports one automation per room', () => {
    expect(automations).toHaveLength(6);
  });

  describe('parlour:room_temp_feed', () => {
    const automation = automations.find(a => a.id === 'parlour:room_temp_feed')!;

    it('converts temp to centidegrees and calls set_value on state change', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '19.5'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '19.5' } },
      });
      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.decision).toBe('update_external_temp');
        expect(result.actions).toEqual([{
          type: 'ha.call_service',
          domain: 'number',
          service: 'set_value',
          target: { entity_id: 'number.parlour_trv_external_measured_room_sensor' },
          data: { value: 1950 },
        }]);
      }
    });

    it('rounds to nearest centidegree', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '19.567'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '19.567' } },
      });
      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.actions[0]).toMatchObject({ data: { value: 1957 } });
      }
    });

    it('aborts when temp is unavailable', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', 'unavailable'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: 'unavailable' } },
      });
      expect(result).toMatchObject({ abort: true, reason: expect.stringContaining('temp_unavailable') });
    });

    it('fires on heartbeat schedule', () => {
      const result = testAutomation(automation, {
        event: scheduleTrigger,
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '20.0' } },
      });
      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.decision).toBe('update_external_temp');
        expect(result.actions[0]).toMatchObject({ data: { value: 2000 } });
      }
    });
  });

  describe('hallway_downstairs:room_temp_feed', () => {
    const automation = automations.find(a => a.id === 'hallway_downstairs:room_temp_feed')!;

    it('reads from the motion sensor and targets the downstairs TRV', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.hallway_downstairs_sensor_motion_temperature', '18.0'),
        state: { 'sensor.hallway_downstairs_sensor_motion_temperature': { state: '18.0' } },
      });
      expect('abort' in result).toBe(false);
      if (!('abort' in result)) {
        expect(result.actions).toEqual([{
          type: 'ha.call_service',
          domain: 'number',
          service: 'set_value',
          target: { entity_id: 'number.hallway_downstairs_trv_external_measured_room_sensor' },
          data: { value: 1800 },
        }]);
      }
    });
  });
});
