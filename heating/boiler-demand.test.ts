import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
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
    expect(result.reason).toBe('demand_ended');
    expect(result.outcome).toBe('acted');
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
    expect(result.reason).toBe('heating_disabled_idle');
    expect(result.outcome).toBe('ignored');
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
    expect(result.reason).toBe('demand_started');
    expect(result.outcome).toBe('acted');
    expect(result.facts).toEqual({ rooms: 'parlour,bedroom', unconfirmed_rooms: '' });
    expect(result.outcome).toBe('acted');
  });

  it('aborts when heating enabled state is unavailable', () => {
    const result = testAbort(automation, {
      event: heatRequiredTrigger('parlour'),
      state: { ...baseState, 'input_boolean.house_heating_enabled': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('heating_enabled_unavailable'));
  });

  describe('what the history says, from the receiver setpoint', () => {
    const RECEIVER = 'climate.boiler_receiver_heat';
    const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };
    const switchTrigger = {
      type: 'state_changed' as const,
      entity_id: 'input_boolean.house_heating_enabled',
      old_state: { entity_id: 'input_boolean.house_heating_enabled', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
      new_state: { entity_id: 'input_boolean.house_heating_enabled', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
      correlation_id: 'test-cid',
    };
    const calling = { ...baseState, 'binary_sensor.parlour_trv_heat_required': { state: 'on' }, 'binary_sensor.bedroom_trv_heat_required': { state: 'on' } };
    const disabled = { ...calling, 'input_boolean.house_heating_enabled': { state: 'off' } };
    const receiver = (setpoint: unknown) => ({ [RECEIVER]: { state: 'heat', attributes: { temperature: setpoint } } });
    const publish = (setpoint: number) => [{
      type: 'mqtt.publish', topic: 'zigbee2mqtt/boiler_receiver/set', retain: false,
      payload: JSON.stringify({ system_mode_heat: 'heat', temperature_setpoint_hold_heat: 1, occupied_heating_setpoint_heat: setpoint }),
    }];
    const run = (event: Parameters<typeof testAutomation>[1]['event'], state: Record<string, unknown>) =>
      testAutomation(automation, { event, state: state as never });

    it.each([
      ['was not calling', receiver(5), 'demand_started', 'acted'],
      ['was already calling', receiver(30), 'demand', 'ignored'],
      ['prior setpoint unknown', {}, 'demand_started', 'acted'],
      ['prior setpoint unavailable', receiver('unavailable'), 'demand_started', 'acted'],
      ['prior setpoint a numeric string', receiver('30.0'), 'demand', 'ignored'],
      ['prior setpoint blank', receiver(''), 'demand_started', 'acted'],
    ])('demand when %s is %s (%s)', (_name, prior, reason, outcome) => {
      const result = run(heatRequiredTrigger('parlour'), { ...calling, ...prior });
      expect(result).toMatchObject({ decision: 'boiler_on', reason, outcome, actions: publish(30) });
      expect(result.facts).toEqual({ rooms: 'parlour,bedroom', unconfirmed_rooms: '' });
    });

    it.each([
      ['was calling', receiver(30), 'demand_ended', 'acted'],
      ['was already off', receiver(5), 'no_demand', 'ignored'],
      ['prior setpoint unknown', {}, 'demand_ended', 'acted'],
    ])('no demand when %s is %s (%s)', (_name, prior, reason, outcome) => {
      const result = run(heatRequiredTrigger('parlour'), { ...baseState, ...prior });
      expect(result).toMatchObject({ decision: 'boiler_off', reason, outcome, actions: publish(5) });
    });

    it('treats the midpoint setpoint as calling', () => {
      expect(run(heatRequiredTrigger('parlour'), { ...calling, ...receiver(17.5) }).reason).toBe('demand');
      expect(run(heatRequiredTrigger('parlour'), { ...calling, ...receiver(17.4) }).reason).toBe('demand_started');
    });

    it('is acted only when the master switch was just flipped off', () => {
      expect(run(switchTrigger, disabled)).toMatchObject({ decision: 'boiler_off', reason: 'heating_disabled', outcome: 'acted', actions: publish(5) });
      expect(run(heatRequiredTrigger('parlour'), disabled)).toMatchObject({ reason: 'heating_disabled_idle', outcome: 'ignored', actions: publish(5) });
    });

    it('uses only ignored variants, with the same publishes, after a homerun restart', () => {
      expect(run(onStart, { ...calling, ...receiver(5) })).toMatchObject({ decision: 'boiler_on', reason: 'demand', outcome: 'ignored', actions: publish(30) });
      expect(run(onStart, { ...baseState, ...receiver(30) })).toMatchObject({ decision: 'boiler_off', reason: 'no_demand', outcome: 'ignored', actions: publish(5) });
      expect(run(onStart, disabled)).toMatchObject({ reason: 'heating_disabled_idle', outcome: 'ignored', actions: publish(5) });
    });
  });

  describe('a TRV whose temperature feed is not confirmed cannot call the boiler', () => {
    const HOUR = 3_600_000;
    const NOW = Date.parse('2026-11-21T23:30:00Z');
    const ago = (ms: number) => new Date(NOW - ms).toISOString();
    const schedule = { type: 'schedule' as const, cron: '*/5 * * * *', correlation_id: 'test-cid' };
    const RECEIVER = 'climate.boiler_receiver_heat';
    const receiver = (setpoint: unknown) => ({ [RECEIVER]: { state: 'heat', attributes: { temperature: setpoint } } });
    const bedroomFeed = (number: string, updatedAgoMs: number, sensor = '19.41') => ({
      'number.bedroom_trv_external_measured_room_sensor': { state: number, last_updated: ago(updatedAgoMs) },
      'sensor.bedroom_sensor_climate_temperature': { state: sensor, last_updated: ago(1000) },
    });
    const bedroomCalling = { ...baseState, 'binary_sensor.bedroom_trv_heat_required': { state: 'on' } };

    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
    afterEach(() => vi.useRealTimers());

    const run = (event: Parameters<typeof testAutomation>[1]['event'], state: Record<string, unknown>) =>
      testAutomation(automation, { event, state: state as never });

    it('turns the boiler off when the only calling room is stale and mismatched (2026-11-21 bedroom)', () => {
      const result = run(schedule, { ...bedroomCalling, ...bedroomFeed('1869', 11 * HOUR), ...receiver(30) });
      expect(result).toMatchObject({ decision: 'boiler_off', reason: 'demand_withheld', outcome: 'acted' });
      expect(result.facts).toEqual({ unconfirmed_rooms: 'bedroom' });
      const action = result.actions[0];
      if (action.type === 'mqtt.publish') expect(JSON.parse(action.payload).occupied_heating_setpoint_heat).toBe(5);
    });

    it('keeps calling for the confirmed rooms and names the withheld one', () => {
      const result = run(schedule, {
        ...bedroomCalling, ...bedroomFeed('1869', 11 * HOUR), ...receiver(30),
        'binary_sensor.parlour_trv_heat_required': { state: 'on' },
      });
      expect(result).toMatchObject({ decision: 'boiler_on', reason: 'demand', outcome: 'ignored' });
      expect(result.facts).toEqual({ rooms: 'parlour', unconfirmed_rooms: 'bedroom' });
    });

    it('still calls for a steady room whose number is old but matches the sensor', () => {
      const result = run(schedule, { ...bedroomCalling, ...bedroomFeed('1941', 11 * HOUR), ...receiver(30) });
      expect(result).toMatchObject({ decision: 'boiler_on', reason: 'demand' });
      expect(result.facts).toEqual({ rooms: 'bedroom', unconfirmed_rooms: '' });
    });

    it('still calls for a fresh mismatch inside the threshold', () => {
      const result = run(schedule, { ...bedroomCalling, ...bedroomFeed('1869', 10 * 60_000), ...receiver(30) });
      expect(result).toMatchObject({ decision: 'boiler_on', reason: 'demand' });
    });

    it.each([
      ['number unavailable', bedroomFeed('unavailable', 11 * HOUR)],
      ['number non-numeric', bedroomFeed('abc', 11 * HOUR)],
      ['sensor unavailable', bedroomFeed('1869', 11 * HOUR, 'unavailable')],
      ['both entities missing', {}],
    ])('keeps today\'s behaviour when %s', (_name, feed) => {
      const result = run(schedule, { ...bedroomCalling, ...feed, ...receiver(30) });
      expect(result).toMatchObject({ decision: 'boiler_on', reason: 'demand' });
    });

    it('uses the ignored variants when the schedule finds nothing changed', () => {
      const withheld = { ...bedroomCalling, ...bedroomFeed('1869', 11 * HOUR) };
      expect(run(schedule, { ...withheld, ...receiver(5) })).toMatchObject({ reason: 'demand_withheld_idle', outcome: 'ignored' });
      expect(run(schedule, { ...baseState, ...receiver(5) })).toMatchObject({ reason: 'no_demand', outcome: 'ignored' });
      expect(run(schedule, { ...bedroomCalling, ...receiver(30) })).toMatchObject({ reason: 'demand', outcome: 'ignored' });
      expect(run({ type: 'on_start', correlation_id: 'c' }, { ...withheld, ...receiver(30) })).toMatchObject({ reason: 'demand_withheld_idle', outcome: 'ignored' });
    });

    it('leaves the heating-disabled behaviour unchanged', () => {
      const off = { ...bedroomCalling, ...bedroomFeed('1869', 11 * HOUR), 'input_boolean.house_heating_enabled': { state: 'off' } };
      expect(run(schedule, off)).toMatchObject({ decision: 'boiler_off', reason: 'heating_disabled_idle', outcome: 'ignored' });
    });
  });
});
