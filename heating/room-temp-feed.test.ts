import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort, testUnavailable } from '@ajclarkson/homerun/testing';
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
  cron: '*/30 * * * *',
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
      expect(result.decision).toBe('update_external_temp');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'number',
        service: 'set_value',
        target: { entity_id: 'number.parlour_trv_external_measured_room_sensor' },
        data: { value: 1950 },
      }]);
    });

    it('rounds to nearest centidegree', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '19.567'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '19.567' } },
      });
      expect(result.actions[0]).toMatchObject({ data: { value: 1957 } });
    });

    it('aborts when temperature is implausibly high, treating it as sensor failure', () => {
      const result = testAbort(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '99.9'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '99.9' } },
      });
      expect(result.reason).toEqual(expect.stringContaining('temp_out_of_range'));
    });

    it('aborts when temperature is sub-zero, treating it as sensor failure', () => {
      const result = testAbort(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '-5.0'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '-5.0' } },
      });
      expect(result.reason).toEqual(expect.stringContaining('temp_out_of_range'));
    });

    it('aborts when temp is unavailable', () => {
      const entityId = testUnavailable(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', 'unavailable'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: 'unavailable' } },
      });
      expect(entityId).toBe('sensor.parlour_sensor_climate_temperature');
    });

    it('uses reason temp_changed on state_changed trigger', () => {
      const result = testAutomation(automation, {
        event: stateChangeTrigger('sensor.parlour_sensor_climate_temperature', '20.0'),
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '20.0' } },
      });
      expect(result.reason).toBe('temp_changed');
    });

    it('uses reason heartbeat on schedule trigger', () => {
      const result = testAutomation(automation, {
        event: scheduleTrigger,
        state: { 'sensor.parlour_sensor_climate_temperature': { state: '20.0' } },
      });
      expect(result.decision).toBe('update_external_temp');
      expect(result.reason).toBe('heartbeat');
      expect(result.actions[0]).toMatchObject({ data: { value: 2000 } });
    });
  });
});
