import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort, testUnavailable } from '@ajclarkson/homerun/testing';
import automation from './door-ventilation.js';

const NOW = new Date('2026-07-21T14:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago
const STALE  = new Date(NOW.getTime() - 90 * 60 * 1000).toISOString(); // 90 min ago

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const triggerEvent = {
  type: 'state_changed' as const,
  entity_id: 'sensor.foreign_office_sensor_climate_temperature',
  old_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '27', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.foreign_office_sensor_climate_temperature', state: '28', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};

// Base: room occupied + wfh, door closed, outdoor cooler, cooldown stale
const baseState = {
  'input_number.foreign_office_automation_door_open_delta': { state: '3' },
  'input_number.foreign_office_automation_door_notification_cooldown_mins': { state: '60' },
  'sensor.foreign_office_sensor_climate_temperature': { state: '28' },
  'weather.forecast_home': { state: 'sunny', attributes: { temperature: 20 } }, // 28 - 3 = 25 threshold; 20 < 25 ✓
  'sensor.foreign_office_plug_fan_power': { state: '0' },
  'binary_sensor.foreign_office_sensor_door_contact': { state: 'off' },
  'binary_sensor.foreign_office_occupied': { state: 'on' },
  'input_boolean.wfh_adam': { state: 'on' },
  'input_text.foreign_office_notification_door_open_last': { state: STALE },
  'input_text.foreign_office_notification_door_close_last': { state: STALE },
};

function run(override: Record<string, unknown> = {}) {
  return testAutomation(automation, { event: triggerEvent, state: { ...baseState, ...override } });
}

// ─── open_door ───────────────────────────────────────────────────────────────

describe('open_door', () => {
  it('notifies when outdoor is cooler by more than delta and door is closed', () => {
    const result = run();
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('open_door');
    expect(result.actions).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ title: 'Open the foreign office door' }),
    }));
  });

  it('records timestamp on open_last helper', () => {
    const result = run();
    expect(result.actions).toContainEqual(expect.objectContaining({
      domain: 'input_text',
      service: 'set_value',
      target: { entity_id: 'input_text.foreign_office_notification_door_open_last' },
    }));
  });

  it('message mentions fan when fan is running', () => {
    const result = run({ 'sensor.foreign_office_plug_fan_power': { state: '25' } });
    const notify = result.actions.find((a: unknown) =>
      (a as { domain?: string }).domain === 'notify'
    ) as { data: { message: string } } | undefined;
    expect(notify?.data.message).toMatch(/fan/);
  });

  it('message mentions cooler air when fan is not running', () => {
    const result = run();
    const notify = result.actions.find((a: unknown) =>
      (a as { domain?: string }).domain === 'notify'
    ) as { data: { message: string } } | undefined;
    expect(notify?.data.message).toMatch(/cooler air/);
  });

  it('suppresses when within cooldown window', () => {
    const result = run({ 'input_text.foreign_office_notification_door_open_last': { state: RECENT } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when door is already open', () => {
    const result = run({ 'binary_sensor.foreign_office_sensor_door_contact': { state: 'on' } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when outdoor is not cool enough', () => {
    // outdoor 24 — delta 3 — threshold 25; 24 < 25 ✓ — so set outdoor to 26 (above threshold)
    const result = run({ 'weather.forecast_home': { state: 'sunny', attributes: { temperature: 26 } } });
    expect(result.decision).toBe('no_action');
  });
});

// ─── close_door ──────────────────────────────────────────────────────────────

describe('close_door', () => {
  const doorOpenWarmState = {
    'binary_sensor.foreign_office_sensor_door_contact': { state: 'on' },
    'weather.forecast_home': { state: 'sunny', attributes: { temperature: 30 } }, // >= foIndoorTemp (28)
  };

  it('notifies when outdoor is at or above indoor temp and door is open', () => {
    const result = run(doorOpenWarmState);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('close_door');
    expect(result.actions).toContainEqual(expect.objectContaining({
      data: expect.objectContaining({ title: 'Close the foreign office door' }),
    }));
  });

  it('records timestamp on close_last helper', () => {
    const result = run(doorOpenWarmState);
    expect(result.actions).toContainEqual(expect.objectContaining({
      domain: 'input_text',
      service: 'set_value',
      target: { entity_id: 'input_text.foreign_office_notification_door_close_last' },
    }));
  });

  it('suppresses when within cooldown window', () => {
    const result = run({
      ...doorOpenWarmState,
      'input_text.foreign_office_notification_door_close_last': { state: RECENT },
    });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when door is already closed', () => {
    const result = run({ 'weather.forecast_home': { state: 'sunny', attributes: { temperature: 30 } } });
    expect(result.decision).toBe('no_action');
  });
});

// ─── active gate ─────────────────────────────────────────────────────────────

describe('active gate', () => {
  it('no_action when room is not occupied', () => {
    const result = run({ 'binary_sensor.foreign_office_occupied': { state: 'off' } });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_active');
  });

  it('no_action when adam is not wfh', () => {
    const result = run({ 'input_boolean.wfh_adam': { state: 'off' } });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_active');
  });
});

// ─── abort ───────────────────────────────────────────────────────────────────

describe('abort on missing sensors', () => {
  it('aborts when indoor temperature is unavailable', () => {
    const entityId = testUnavailable(automation, {
      event: triggerEvent,
      state: { ...baseState, 'sensor.foreign_office_sensor_climate_temperature': { state: 'unavailable' } },
    });
    expect(entityId).toBe('sensor.foreign_office_sensor_climate_temperature');
  });

  it('aborts when outdoor temperature is missing', () => {
    const result = testAbort(automation, {
      event: triggerEvent,
      state: { ...baseState, 'weather.forecast_home': { state: 'sunny', attributes: {} } },
    });
    expect(result.reason).toMatch(/sensor_unavailable:outdoorTemp/);
  });
});
