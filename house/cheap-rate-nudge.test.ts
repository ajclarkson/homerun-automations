import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './cheap-rate-nudge.js';

const scheduleEvent = { type: 'schedule' as const, cron: '0 9 * * *', correlation_id: 'test-cid' };

const baseState = {
  'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': {
    state: 'off',
    attributes: {
      next_time: '2026-07-21T13:00:00+01:00',
      next_average_value: 0.142,
    },
  },
  'sensor.octopus_today_negative_windows': { state: '—' },
  'person.adam': { state: 'home' },
  'person.sarah': { state: 'home' },
};

function run(overrideState: Record<string, unknown> = {}) {
  return testAutomation(automation, { event: scheduleEvent, state: { ...baseState, ...overrideState } });
}

describe('notification message', () => {
  type NotifyAction = { data: { title: string; message: string; data: { url: string } } };
  const asNotify = (a: unknown) => a as NotifyAction;

  it('sends cheapest window message when no negative windows', () => {
    const result = run();
    expect(result.decision).toBe('notify');
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe("Today's cheapest electricity");
    expect(action.data.message).toMatch(/13:00/);
    expect(action.data.message).toMatch(/14\.2p\/kWh/);
  });

  it('sends free electricity message when a single negative window exists', () => {
    const result = run({ 'sensor.octopus_today_negative_windows': { state: '02:00–04:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe('⚡ Free electricity today');
    expect(action.data.message).toBe('02:00–04:00 — tap for all windows');
  });

  it('shows first window and "more" when multiple negative windows exist', () => {
    const result = run({
      'sensor.octopus_today_negative_windows': { state: '02:00–04:00 · 05:00–06:00' },
    });
    const action = asNotify(result.actions[0]);
    expect(action.data.message).toBe('02:00–04:00 + more windows — tap for details');
  });

  it('includes the energy dashboard URL in notification data', () => {
    const result = run();
    const action = asNotify(result.actions[0]);
    expect(action.data.data.url).toBe('/mobile-dashboard/energy');
  });
});

describe('presence routing', () => {
  it('notifies both when both are home', () => {
    const result = run();
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('adam_and_sarah');
    expect(result.actions).toHaveLength(2);
    const targets = result.actions.map((a) => (a as unknown as { target: { entity_id: string } }).target?.entity_id);
    expect(targets).toContain('notify.mobile_app_adams_iphone');
    expect(targets).toContain('notify.mobile_app_sarahs_iphone');
  });

  it('notifies only adam when sarah is away', () => {
    const result = run({ 'person.sarah': { state: 'not_home' } });
    expect(result.reason).toBe('adam');
    expect(result.actions).toHaveLength(1);
    const asTarget = (a: unknown) => (a as { target: { entity_id: string } }).target?.entity_id;
    expect(asTarget(result.actions[0])).toBe('notify.mobile_app_adams_iphone');
  });

  it('notifies only sarah when adam is away', () => {
    const result = run({ 'person.adam': { state: 'not_home' } });
    expect(result.reason).toBe('sarah');
    expect(result.actions).toHaveLength(1);
    const asTarget = (a: unknown) => (a as { target: { entity_id: string } }).target?.entity_id;
    expect(asTarget(result.actions[0])).toBe('notify.mobile_app_sarahs_iphone');
  });

  it('takes no action when nobody is home', () => {
    const result = run({
      'person.adam': { state: 'not_home' },
      'person.sarah': { state: 'not_home' },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('nobody_home');
    expect(result.actions).toHaveLength(0);
  });
});

describe('data unavailable', () => {
  it('aborts when next_time is missing', () => {
    const result = testAbort(automation, {
      event: scheduleEvent,
      state: {
        ...baseState,
        'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': {
          state: 'off',
          attributes: { next_average_value: 0.142 },
        },
      },
    });
    expect(result.reason).toBe('cheapest_window_data_unavailable');
  });

  it('aborts when next_average_value is missing', () => {
    const result = testAbort(automation, {
      event: scheduleEvent,
      state: {
        ...baseState,
        'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': {
          state: 'off',
          attributes: { next_time: '2026-07-21T13:00:00+01:00' },
        },
      },
    });
    expect(result.reason).toBe('cheapest_window_data_unavailable');
  });
});
