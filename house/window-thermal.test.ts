import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort, testUnavailable } from '@ajclarkson/homerun/testing';
import automation from './window-thermal.js';

const TODAY = '2026-07-21';
const YESTERDAY = '2026-07-20';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(`${TODAY}T10:00:00.000Z`)); // 10:00, past any openHour
});
afterEach(() => vi.useRealTimers());

const stateChangedEvent = (entity: string) => ({
  type: 'state_changed' as const,
  entity_id: entity,
  old_state: { entity_id: entity, state: '20', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state: '21', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const triggerEvent = stateChangedEvent('sensor.bedroom_sensor_window_right_device_temperature');

// Base state: cool day, windows open, no notifications sent yet
const baseState = {
  'input_number.bedroom_automation_window_frame_threshold': { state: '35' },
  'input_number.bedroom_automation_window_open_delta': { state: '3' },
  'input_number.bedroom_automation_window_open_hour': { state: '9' },
  'input_number.bedroom_automation_window_indoor_comfort_threshold': { state: '24' },
  'sensor.bedroom_sensor_window_right_device_temperature': { state: '28' },
  'sensor.bedroom_sensor_window_left_device_temperature': { state: '27' },
  'sensor.bedroom_sensor_climate_temperature': { state: '22' },
  'sensor.home_office_sensor_climate_temperature': { state: '23' },
  'weather.forecast_home': { state: 'sunny', attributes: { temperature: 20 } },
  'binary_sensor.bedroom_external_openings': { state: 'on' },
  'binary_sensor.home_office_external_openings': { state: 'on' },
  'input_text.window_notification_close_bedroom': { state: YESTERDAY },
  'input_text.window_notification_close_home_office': { state: YESTERDAY },
  'input_text.window_notification_close_both': { state: YESTERDAY },
  'input_text.window_notification_open_both': { state: YESTERDAY },
  'input_text.window_thermal_hot_event': { state: YESTERDAY },
  'person.adam': { state: 'home' },
  'person.sarah': { state: 'home' },
};

function run(override: Record<string, unknown> = {}) {
  return testAutomation(automation, { event: triggerEvent, state: { ...baseState, ...override } });
}

const expectNotify = (actions: unknown[], title: string) =>
  expect(actions).toContainEqual(expect.objectContaining({ data: expect.objectContaining({ title }) }));

const expectDedupeSet = (actions: unknown[], entity: string) =>
  expect(actions).toContainEqual(expect.objectContaining({
    domain: 'input_text',
    service: 'set_value',
    target: { entity_id: entity },
    data: { value: TODAY },
  }));

const expectHotEvent = (actions: unknown[]) =>
  expectDedupeSet(actions, 'input_text.window_thermal_hot_event');

// ─── close_both ──────────────────────────────────────────────────────────────

describe('close_both', () => {
  const hotOpenState = {
    'sensor.bedroom_sensor_window_right_device_temperature': { state: '38' }, // > frameThreshold (35)
    'weather.forecast_home': { state: 'sunny', attributes: { temperature: 25 } }, // > hoIndoorTemp (23)
    'binary_sensor.bedroom_external_openings': { state: 'on' },
  };

  it('notifies when frames hot, outside warmer, and a window is open', () => {
    const result = run(hotOpenState);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('close_both');
    expectNotify(result.actions, 'Close bedroom and home office windows');
    expectDedupeSet(result.actions, 'input_text.window_notification_close_both');
    expectHotEvent(result.actions);
  });

  it('notifies if only bedroom is open', () => {
    const result = run({ ...hotOpenState, 'binary_sensor.home_office_external_openings': { state: 'off' } });
    expect(result.reason).toBe('close_both');
  });

  it('suppresses if close_both already sent today', () => {
    const result = run({ ...hotOpenState, 'input_text.window_notification_close_both': { state: TODAY } });
    expect(result.decision).toBe('no_action');
  });

  it('does not send close_both if any close notification already sent today', () => {
    const result = run({
      ...hotOpenState,
      'input_text.window_notification_close_bedroom': { state: TODAY },
      'input_text.window_notification_close_home_office': { state: TODAY },
    });
    expect(result.reason).not.toBe('close_both');
  });

  it('still records hot event even when suppressed', () => {
    const result = run({ ...hotOpenState, 'input_text.window_notification_close_both': { state: TODAY } });
    expectHotEvent(result.actions);
  });
});

// ─── close_bedroom ───────────────────────────────────────────────────────────

describe('close_bedroom', () => {
  // Frame hot (solar gain on the sensor), but also: outside genuinely warmer than the
  // bedroom's own air, and the bedroom is already at/above the comfort threshold.
  // Home office stays out of it (hoIndoorTemp above outdoor) so close_both/close_home_office don't fire.
  const hotFrameState = {
    'sensor.bedroom_sensor_window_right_device_temperature': { state: '38' },
    'sensor.bedroom_sensor_climate_temperature': { state: '25' }, // >= comfort threshold (24)
    'sensor.home_office_sensor_climate_temperature': { state: '27' }, // outdoor stays below this
    'weather.forecast_home': { state: 'sunny', attributes: { temperature: 26 } }, // > bedroomTemp, < hoIndoorTemp
    'binary_sensor.bedroom_external_openings': { state: 'on' },
  };

  it('notifies when frames hot, outside warmer than bedroom, and bedroom air is actually warm', () => {
    const result = run(hotFrameState);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('close_bedroom');
    expectNotify(result.actions, 'Close the bedroom windows');
    expectDedupeSet(result.actions, 'input_text.window_notification_close_bedroom');
  });

  it('suppresses if already sent today', () => {
    const result = run({ ...hotFrameState, 'input_text.window_notification_close_bedroom': { state: TODAY } });
    expect(result.decision).toBe('no_action');
  });

  it('suppresses if close_both already sent today', () => {
    const result = run({ ...hotFrameState, 'input_text.window_notification_close_both': { state: TODAY } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when bedroom window is already closed', () => {
    const result = run({ ...hotFrameState, 'binary_sensor.bedroom_external_openings': { state: 'off' } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when frame is hot from direct sun but outside is not actually warmer than the bedroom', () => {
    // This is the real-world case that motivated the extra gates: a mild ~25°C day where the
    // frame sensor spikes from direct sun (33-36°C) while indoor air and outdoor temp stay unremarkable.
    const result = run({
      ...hotFrameState,
      'weather.forecast_home': { state: 'sunny', attributes: { temperature: 18 } },
    });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when outside is warmer than bedroom but the bedroom itself is not yet warm', () => {
    const result = run({
      ...hotFrameState,
      'sensor.bedroom_sensor_climate_temperature': { state: '20' }, // below comfort threshold (24)
    });
    expect(result.decision).toBe('no_action');
  });
});

// ─── close_home_office ───────────────────────────────────────────────────────

describe('close_home_office', () => {
  const warmOutsideState = {
    'weather.forecast_home': { state: 'sunny', attributes: { temperature: 26 } }, // > hoIndoorTemp (23)
    'binary_sensor.home_office_external_openings': { state: 'on' },
  };

  it('notifies when outside warmer than home office and window open', () => {
    const result = run(warmOutsideState);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('close_home_office');
    expectNotify(result.actions, 'Close the home office windows');
    expectDedupeSet(result.actions, 'input_text.window_notification_close_home_office');
  });

  it('suppresses if already sent today', () => {
    const result = run({ ...warmOutsideState, 'input_text.window_notification_close_home_office': { state: TODAY } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when home office window is closed', () => {
    const result = run({ ...warmOutsideState, 'binary_sensor.home_office_external_openings': { state: 'off' } });
    expect(result.decision).toBe('no_action');
  });
});

// ─── open_both ───────────────────────────────────────────────────────────────

describe('open_both', () => {
  // avgIndoorTemp = (22 + 23) / 2 = 22.5; outsideCooler = outdoorTemp < 22.5 - 3 = 19.5
  const coolEveningState = {
    'weather.forecast_home': { state: 'clear-night', attributes: { temperature: 17 } },
    'binary_sensor.bedroom_external_openings': { state: 'off' },
    'input_text.window_thermal_hot_event': { state: TODAY }, // hot event recorded earlier today
  };

  it('notifies when outside is cooler, frames cool, windows closed, after openHour, hot event today', () => {
    const result = run(coolEveningState);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('open_both');
    expectNotify(result.actions, 'Open the windows');
    expectDedupeSet(result.actions, 'input_text.window_notification_open_both');
  });

  it('suppresses if open_both already sent today', () => {
    const result = run({ ...coolEveningState, 'input_text.window_notification_open_both': { state: TODAY } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when no hot event today', () => {
    const result = run({ ...coolEveningState, 'input_text.window_thermal_hot_event': { state: YESTERDAY } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when outside is not cool enough (within delta)', () => {
    const result = run({ ...coolEveningState, 'weather.forecast_home': { state: 'cloudy', attributes: { temperature: 20 } } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when frames are still hot', () => {
    const result = run({
      ...coolEveningState,
      'sensor.bedroom_sensor_window_right_device_temperature': { state: '38' },
    });
    expect(result.decision).toBe('no_action');
  });

  it('no_action before openHour', () => {
    vi.setSystemTime(new Date(`${TODAY}T07:00:00.000Z`));
    const result = run({ ...coolEveningState, 'input_number.bedroom_automation_window_open_hour': { state: '9' } });
    expect(result.decision).toBe('no_action');
  });

  it('no_action when both windows already open', () => {
    const result = run({
      ...coolEveningState,
      'binary_sensor.bedroom_external_openings': { state: 'on' },
      'binary_sensor.home_office_external_openings': { state: 'on' },
    });
    expect(result.decision).toBe('no_action');
  });
});

// ─── presence routing ────────────────────────────────────────────────────────

describe('presence routing', () => {
  const hotOpenState = {
    'sensor.bedroom_sensor_window_right_device_temperature': { state: '38' },
    'weather.forecast_home': { state: 'sunny', attributes: { temperature: 25 } },
  };

  it('notifies both when both are home', () => {
    const result = run(hotOpenState);
    const notifyActions = result.actions.filter((a: unknown) =>
      (a as { domain?: string }).domain === 'notify'
    );
    expect(notifyActions).toHaveLength(2);
  });

  it('notifies only adam when sarah is away', () => {
    const result = run({ ...hotOpenState, 'person.sarah': { state: 'not_home' } });
    const notifyActions = result.actions.filter((a: unknown) =>
      (a as { domain?: string }).domain === 'notify'
    );
    expect(notifyActions).toHaveLength(1);
    expect((notifyActions[0] as { service: string }).service)
      .toBe('mobile_app_adams_iphone');
  });

  it('takes no notify action when nobody home but still records hot event', () => {
    const result = run({
      ...hotOpenState,
      'person.adam': { state: 'not_home' },
      'person.sarah': { state: 'not_home' },
    });
    expect(result.decision).toBe('notify');
    const notifyActions = result.actions.filter((a: unknown) =>
      (a as { domain?: string }).domain === 'notify'
    );
    expect(notifyActions).toHaveLength(0);
    expectHotEvent(result.actions);
  });
});

// ─── abort conditions ────────────────────────────────────────────────────────

describe('abort on missing sensors', () => {
  it('aborts when a window frame temperature is unavailable', () => {
    const entityId = testUnavailable(automation, {
      event: triggerEvent,
      state: {
        ...baseState,
        'sensor.bedroom_sensor_window_right_device_temperature': { state: 'unavailable' },
      },
    });
    expect(entityId).toBe('sensor.bedroom_sensor_window_right_device_temperature');
  });

  it('aborts when outdoor temperature is missing from weather attributes', () => {
    const result = testAbort(automation, {
      event: triggerEvent,
      state: {
        ...baseState,
        'weather.forecast_home': { state: 'sunny', attributes: {} },
      },
    });
    expect(result.reason).toMatch(/sensor_unavailable:outdoorTemp/);
  });
});
