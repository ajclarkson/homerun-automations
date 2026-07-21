import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './lighting.js';

const baseState = {
  'input_boolean.back_garden_automation_lights_enabled': { state: 'on' },
  'sun.sun': { state: 'above_horizon' },
};

const sunsetEvent = {
  type: 'state_changed' as const,
  entity_id: 'sun.sun',
  old_state: { entity_id: 'sun.sun', state: 'above_horizon', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sun.sun', state: 'below_horizon', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};

const sunriseEvent = {
  ...sunsetEvent,
  old_state: { ...sunsetEvent.old_state, state: 'below_horizon' },
  new_state: { ...sunsetEvent.new_state, state: 'above_horizon' },
};

const scheduleEvent = { type: 'schedule' as const, cron: '0 22 * * *', correlation_id: 'test-cid' };
const onStartEvent = { type: 'on_start' as const, correlation_id: 'test-cid' };

function run(
  event: typeof sunsetEvent | typeof scheduleEvent | typeof onStartEvent | typeof sunriseEvent,
  overrideState: Record<string, { state: string }> = {},
) {
  return testAutomation(automation, { event, state: { ...baseState, ...overrideState } });
}

const expectSceneOn = (actions: unknown[]) =>
  expect(actions).toContainEqual(expect.objectContaining({ service: 'turn_on', target: { entity_id: 'scene.back_garden_all' } }));

const expectSceneOff = (actions: unknown[]) =>
  expect(actions).toContainEqual(expect.objectContaining({ service: 'turn_on', target: { entity_id: 'scene.back_garden_off' } }));

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-07T20:00:00.000Z')); // 20:00 — before 22:00
});

afterEach(() => vi.useRealTimers());

describe('sunset trigger', () => {
  it('turns lights on at sunset when before 22:00', () => {
    const result = run(sunsetEvent, { 'sun.sun': { state: 'below_horizon' } });
    expect(result.decision).toBe('turn_on');
    expect(result.reason).toBe('sunset');
    expectSceneOn(result.actions);
  });

  it('does not turn on at sunset when at or after 22:00', () => {
    vi.setSystemTime(new Date('2026-01-07T22:00:00.000Z'));
    const result = run(sunsetEvent, { 'sun.sun': { state: 'below_horizon' } });
    expect(result.decision).toBe('no_action');
  });
});

describe('schedule off trigger', () => {
  it('turns lights off at 22:00', () => {
    vi.setSystemTime(new Date('2026-01-07T22:00:00.000Z'));
    const result = run(scheduleEvent, { 'sun.sun': { state: 'below_horizon' } });
    expect(result.decision).toBe('turn_off');
    expect(result.reason).toBe('schedule_off');
    expectSceneOff(result.actions);
  });
});

describe('sunrise trigger', () => {
  it('turns lights off at sunrise', () => {
    vi.setSystemTime(new Date('2026-01-07T08:00:00.000Z'));
    const result = run(sunriseEvent, { 'sun.sun': { state: 'above_horizon' } });
    expect(result.decision).toBe('turn_off');
    expect(result.reason).toBe('sunrise');
    expectSceneOff(result.actions);
  });
});

describe('startup sync', () => {
  it('turns lights on if sun is below horizon and before 22:00', () => {
    const result = run(onStartEvent, { 'sun.sun': { state: 'below_horizon' } });
    expect(result.decision).toBe('turn_on');
    expect(result.reason).toBe('startup_sync');
    expectSceneOn(result.actions);
  });

  it('turns lights off if sun is above horizon', () => {
    const result = run(onStartEvent, { 'sun.sun': { state: 'above_horizon' } });
    expect(result.decision).toBe('turn_off');
    expect(result.reason).toBe('startup_sync');
    expectSceneOff(result.actions);
  });

  it('turns lights off if sun is below horizon but at or after 22:00', () => {
    vi.setSystemTime(new Date('2026-01-07T22:30:00.000Z'));
    const result = run(onStartEvent, { 'sun.sun': { state: 'below_horizon' } });
    expect(result.decision).toBe('turn_off');
    expectSceneOff(result.actions);
  });
});

describe('automation disabled', () => {
  it('takes no action regardless of trigger', () => {
    const result = run(sunsetEvent, {
      'input_boolean.back_garden_automation_lights_enabled': { state: 'off' },
      'sun.sun': { state: 'below_horizon' },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('automation_disabled');
    expect(result.actions).toEqual([]);
  });
});
