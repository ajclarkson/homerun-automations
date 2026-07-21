import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import { cheapRateNudge, tomorrowRatesNudge } from './octopus-rates.js';

type NotifyAction = { data: { title: string; message: string; data: { url: string } }; target: { entity_id: string } };
const asNotify = (a: unknown) => a as NotifyAction;

const scheduleEvent = { type: 'schedule' as const, cron: '0 9 * * *', correlation_id: 'test-cid' };

const dataAvailableEvent = {
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.octopus_tomorrow_data_available',
  old_state: { entity_id: 'binary_sensor.octopus_tomorrow_data_available', state: 'off', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.octopus_tomorrow_data_available', state: 'on',  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};

const dataUnavailableEvent = {
  ...dataAvailableEvent,
  old_state: { ...dataAvailableEvent.old_state, state: 'on' },
  new_state: { ...dataAvailableEvent.new_state, state: 'off' },
};

// ─── Today: cheap rate nudge ─────────────────────────────────────────────────

const todayBaseState = {
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

function runToday(override: Record<string, unknown> = {}) {
  return testAutomation(cheapRateNudge, { event: scheduleEvent, state: { ...todayBaseState, ...override } });
}

describe('cheap rate nudge — message', () => {
  it('sends cheapest window message when no negative windows', () => {
    const result = runToday();
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe("Today's cheapest electricity");
    expect(action.data.message).toMatch(/\d{2}:\d{2}/);
    expect(action.data.message).toMatch(/14\.2p\/kWh/);
  });

  it('sends free electricity message for a single negative window', () => {
    const result = runToday({ 'sensor.octopus_today_negative_windows': { state: '02:00–04:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe('⚡ Free electricity today');
    expect(action.data.message).toBe('02:00–04:00 — tap for all windows');
  });

  it('shows first window and overflow hint for multiple negative windows', () => {
    const result = runToday({ 'sensor.octopus_today_negative_windows': { state: '02:00–04:00 · 05:00–06:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.message).toBe('02:00–04:00 + more windows — tap for details');
  });

  it('includes the energy dashboard URL', () => {
    const result = runToday();
    expect(asNotify(result.actions[0]).data.data.url).toBe('/mobile-dashboard/energy');
  });
});

describe('cheap rate nudge — presence routing', () => {
  it('notifies both when both are home', () => {
    const result = runToday();
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('adam_and_sarah');
    expect(result.actions).toHaveLength(2);
    const targets = result.actions.map((a) => asNotify(a).target.entity_id);
    expect(targets).toContain('notify.mobile_app_adams_iphone');
    expect(targets).toContain('notify.mobile_app_sarahs_iphone');
  });

  it('notifies only adam when sarah is away', () => {
    const result = runToday({ 'person.sarah': { state: 'not_home' } });
    expect(result.reason).toBe('adam');
    expect(result.actions).toHaveLength(1);
    expect(asNotify(result.actions[0]).target.entity_id).toBe('notify.mobile_app_adams_iphone');
  });

  it('notifies only sarah when adam is away', () => {
    const result = runToday({ 'person.adam': { state: 'not_home' } });
    expect(result.reason).toBe('sarah');
    expect(result.actions).toHaveLength(1);
    expect(asNotify(result.actions[0]).target.entity_id).toBe('notify.mobile_app_sarahs_iphone');
  });

  it('takes no action when nobody is home', () => {
    const result = runToday({ 'person.adam': { state: 'not_home' }, 'person.sarah': { state: 'not_home' } });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('nobody_home');
    expect(result.actions).toHaveLength(0);
  });
});

describe('cheap rate nudge — data unavailable', () => {
  it('aborts when next_time is missing', () => {
    const result = testAbort(cheapRateNudge, {
      event: scheduleEvent,
      state: {
        ...todayBaseState,
        'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': {
          state: 'off',
          attributes: { next_average_value: 0.142 },
        },
      },
    });
    expect(result.reason).toBe('cheapest_window_data_unavailable');
  });

  it('aborts when next_average_value is missing', () => {
    const result = testAbort(cheapRateNudge, {
      event: scheduleEvent,
      state: {
        ...todayBaseState,
        'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours': {
          state: 'off',
          attributes: { next_time: '2026-07-21T13:00:00+01:00' },
        },
      },
    });
    expect(result.reason).toBe('cheapest_window_data_unavailable');
  });
});

// ─── Tomorrow: rates nudge ───────────────────────────────────────────────────

const tomorrowBaseState = {
  'binary_sensor.octopus_tomorrow_data_available': { state: 'on' },
  'sensor.octopus_tomorrow_negative_windows': { state: '—' },
  'sensor.octopus_tomorrow_cheap_windows': { state: '01:00–03:00' },
};

function runTomorrow(override: Record<string, unknown> = {}) {
  return testAutomation(tomorrowRatesNudge, { event: dataAvailableEvent, state: { ...tomorrowBaseState, ...override } });
}

describe('tomorrow rates nudge — message', () => {
  it('sends free electricity message for a single negative window', () => {
    const result = runTomorrow({ 'sensor.octopus_tomorrow_negative_windows': { state: '02:00–04:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe('⚡ Free electricity tomorrow');
    expect(action.data.message).toBe('02:00–04:00 — tap for all windows');
  });

  it('includes cheap windows hint when both negative and cheap windows exist', () => {
    const result = runTomorrow({ 'sensor.octopus_tomorrow_negative_windows': { state: '02:00–04:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.message).toContain('tap for all windows');
  });

  it('shows first negative window and overflow for multiple negative windows', () => {
    const result = runTomorrow({ 'sensor.octopus_tomorrow_negative_windows': { state: '02:00–04:00 · 05:00–06:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.message).toBe('02:00–04:00 + more windows — tap for details');
  });

  it('sends cheap rates message when no negative windows', () => {
    const result = runTomorrow();
    const action = asNotify(result.actions[0]);
    expect(action.data.title).toBe("Tomorrow's cheap rates");
    expect(action.data.message).toBe('01:00–03:00 — tap for details');
  });

  it('shows overflow hint for multiple cheap windows', () => {
    const result = runTomorrow({ 'sensor.octopus_tomorrow_cheap_windows': { state: '01:00–03:00 · 04:00–05:00' } });
    const action = asNotify(result.actions[0]);
    expect(action.data.message).toBe('01:00–03:00 + more — tap for details');
  });
});

describe('tomorrow rates nudge — always notifies both people', () => {
  it('notifies both adam and sarah regardless of presence', () => {
    const result = runTomorrow();
    expect(result.decision).toBe('notify');
    expect(result.actions).toHaveLength(2);
    const targets = result.actions.map((a) => asNotify(a).target.entity_id);
    expect(targets).toContain('notify.mobile_app_adams_iphone');
    expect(targets).toContain('notify.mobile_app_sarahs_iphone');
  });
});

describe('tomorrow rates nudge — abort conditions', () => {
  it('aborts when data availability sensor is off', () => {
    const result = testAbort(tomorrowRatesNudge, {
      event: dataUnavailableEvent,
      state: { ...tomorrowBaseState, 'binary_sensor.octopus_tomorrow_data_available': { state: 'off' } },
    });
    expect(result.reason).toBe('tomorrow_data_not_available');
  });

  it('aborts when no notable windows exist', () => {
    const result = testAbort(tomorrowRatesNudge, {
      event: dataAvailableEvent,
      state: {
        ...tomorrowBaseState,
        'sensor.octopus_tomorrow_negative_windows': { state: '—' },
        'sensor.octopus_tomorrow_cheap_windows': { state: '—' },
      },
    });
    expect(result.reason).toBe('no_notable_windows_tomorrow');
  });
});
