import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import { adamWfh, sarahWfh, wfhReset } from './wfh.js';

const WED = new Date('2026-07-22T06:00:00.000Z'); // Wednesday
const MON = new Date('2026-07-20T08:00:00.000Z'); // Monday

const adamScheduleEvent = { type: 'schedule' as const, cron: '0 6 * * 3-5', correlation_id: 'test-cid' };
const adamMonTueEvent   = { type: 'schedule' as const, cron: '0 8 * * 1-2', correlation_id: 'test-cid' };
const sarahScheduleEvent = { type: 'schedule' as const, cron: '15 7 * * 1-5', correlation_id: 'test-cid' };
const workdayOffEvent = {
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.workday_sensor',
  old_state: { entity_id: 'binary_sensor.workday_sensor', state: 'on', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.workday_sensor', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};
const workdayOnEvent = {
  ...workdayOffEvent,
  old_state: { ...workdayOffEvent.old_state, state: 'off' },
  new_state: { ...workdayOffEvent.new_state, state: 'on' },
};

const baseState = {
  'sensor.house_active_mode': { state: 'normal' },
  'binary_sensor.workday_sensor': { state: 'on' },
  'person.adam': { state: 'home' },
  'person.sarah': { state: 'home' },
};

const expectBooleanOn  = (actions: unknown[], entity: string) =>
  expect(actions).toContainEqual(expect.objectContaining({ service: 'turn_on',  target: { entity_id: entity } }));
const expectBooleanOff = (actions: unknown[], entity: string) =>
  expect(actions).toContainEqual(expect.objectContaining({ service: 'turn_off', target: { entity_id: entity } }));

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

// ─── Adam ────────────────────────────────────────────────────────────────────

describe('Adam WFH — Wed–Fri always on', () => {
  beforeEach(() => vi.setSystemTime(WED));

  it('sets wfh_adam on when workday and Wed–Fri', () => {
    const result = testAutomation(adamWfh, { event: adamScheduleEvent, state: baseState });
    expect(result.decision).toBe('on');
    expect(result.reason).toBe('always_wfh_wed_fri');
    expectBooleanOn(result.actions, 'input_boolean.wfh_adam');
  });

  it('sets wfh_adam off when house is away even on Wed–Fri', () => {
    const result = testAutomation(adamWfh, {
      event: adamScheduleEvent,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'away' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('house_away');
    expectBooleanOff(result.actions, 'input_boolean.wfh_adam');
  });

  it('sets wfh_adam off when workday sensor is off even on Wed–Fri', () => {
    const result = testAutomation(adamWfh, {
      event: adamScheduleEvent,
      state: { ...baseState, 'binary_sensor.workday_sensor': { state: 'off' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('not_workday');
  });
});

describe('Adam WFH — Mon–Tue presence check', () => {
  beforeEach(() => vi.setSystemTime(MON));

  it('sets wfh_adam on when home at 08:00', () => {
    const result = testAutomation(adamWfh, { event: adamMonTueEvent, state: baseState });
    expect(result.decision).toBe('on');
    expect(result.reason).toBe('home_at_inference_time');
    expectBooleanOn(result.actions, 'input_boolean.wfh_adam');
  });

  it('sets wfh_adam off when not home at 08:00', () => {
    const result = testAutomation(adamWfh, {
      event: adamMonTueEvent,
      state: { ...baseState, 'person.adam': { state: 'not_home' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('not_home_at_inference_time');
    expectBooleanOff(result.actions, 'input_boolean.wfh_adam');
  });
});

// ─── Sarah ───────────────────────────────────────────────────────────────────

describe('Sarah WFH', () => {
  beforeEach(() => vi.setSystemTime(MON));

  it('sets wfh_sarah on when home at 07:15 on a workday', () => {
    const result = testAutomation(sarahWfh, { event: sarahScheduleEvent, state: baseState });
    expect(result.decision).toBe('on');
    expect(result.reason).toBe('home_at_inference_time');
    expectBooleanOn(result.actions, 'input_boolean.wfh_sarah');
  });

  it('sets wfh_sarah off when not home at 07:15', () => {
    const result = testAutomation(sarahWfh, {
      event: sarahScheduleEvent,
      state: { ...baseState, 'person.sarah': { state: 'not_home' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('not_home_at_inference_time');
    expectBooleanOff(result.actions, 'input_boolean.wfh_sarah');
  });

  it('sets wfh_sarah off when house is away', () => {
    const result = testAutomation(sarahWfh, {
      event: sarahScheduleEvent,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'away' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('house_away');
  });

  it('sets wfh_sarah off when not a workday', () => {
    const result = testAutomation(sarahWfh, {
      event: sarahScheduleEvent,
      state: { ...baseState, 'binary_sensor.workday_sensor': { state: 'off' } },
    });
    expect(result.decision).toBe('off');
    expect(result.reason).toBe('not_workday');
  });
});

// ─── Reset ───────────────────────────────────────────────────────────────────

describe('WFH reset', () => {
  it('clears both flags when workday sensor goes off', () => {
    const result = testAutomation(wfhReset, {
      event: workdayOffEvent,
      state: { ...baseState, 'binary_sensor.workday_sensor': { state: 'off' } },
    });
    expect(result.decision).toBe('clear');
    expect(result.reason).toBe('non_workday');
    expectBooleanOff(result.actions, 'input_boolean.wfh_adam');
    expectBooleanOff(result.actions, 'input_boolean.wfh_sarah');
  });

  it('takes no action when workday sensor turns on (not a clear event)', () => {
    const result = testAutomation(wfhReset, {
      event: workdayOnEvent,
      state: baseState,
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_a_non_workday');
    expect(result.actions).toHaveLength(0);
  });
});
