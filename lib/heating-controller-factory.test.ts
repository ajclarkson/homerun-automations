import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import { makeHeatingAutomation, type HeatingRoomConfig } from './heating-controller-factory.js';

// ---- Test fixtures ----

const LOCATION = 'parlour';

const baseConfig: HeatingRoomConfig = {
  location: LOCATION,
  scheduleConfig: {
    byContext: {
      weekday: [
        { start: '06:00', end: '16:00', mode: 'baseline_day' },
        { start: '16:00', end: '22:00', mode: 'comfort' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
      weekend: [
        { start: '06:00', end: '22:00', mode: 'comfort' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
      default: [
        { start: '00:00', end: '24:00', mode: 'baseline_day' },
      ],
    },
  },
};

const baseState = {
  [`input_boolean.${LOCATION}_automation_heating_enabled`]: { state: 'on' },
  [`sensor.${LOCATION}_active_heating`]: { state: 'baseline_day' },
  [`binary_sensor.${LOCATION}_external_openings`]: { state: 'off' },
  'input_boolean.house_heating_enabled': { state: 'on' },
  'sensor.house_active_mode': { state: 'normal' },
  'input_boolean.wfh_adam': { state: 'off' },
  'input_boolean.wfh_sarah': { state: 'off' },
  [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'auto' },
  [`sensor.${LOCATION}_occupied`]: { state: 'unoccupied' },
};

const onStartEvent = { type: 'on_start' as const, correlation_id: 'test-cid' };

// Pin time to a Wednesday at 10:00 (weekday, baseline_day block)
function pinTime(isoString: string) {
  vi.setSystemTime(new Date(isoString));
}

beforeEach(() => {
  vi.useFakeTimers();
  pinTime('2026-01-07T10:00:00.000Z'); // Wednesday 10:00
});

afterEach(() => {
  vi.useRealTimers();
});

function run(
  overrideState: Record<string, { state: string }> = {},
  config: HeatingRoomConfig = baseConfig,
) {
  const automation = makeHeatingAutomation(config);
  return testAutomation(automation, {
    event: onStartEvent,
    state: { ...baseState, ...overrideState },
  });
}

// ---- Abort conditions ----

describe('aborts', () => {
  it('aborts when automation_enabled entity is unavailable', () => {
    const automation = makeHeatingAutomation(baseConfig);
    testAbort(automation, {
      event: onStartEvent,
      state: { ...baseState, [`input_boolean.${LOCATION}_automation_heating_enabled`]: { state: 'unavailable' } },
    });
  });
});

// ---- Stage 1: automation disabled ----

describe('when automation is disabled', () => {
  it('returns blocked and emits no actions', () => {
    const result = run({ [`input_boolean.${LOCATION}_automation_heating_enabled`]: { state: 'off' } });
    expect(result.decision).toBe('blocked');
    expect(result.reason).toBe('automation_disabled');
    expect(result.actions).toEqual([]);
  });
});

// ---- Stage 2: safety overrides ----

describe('safety — window open', () => {
  it('forces minimum regardless of schedule', () => {
    const result = run({ [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('safety_window_open');
    expectModePublished(result.actions, 'minimum');
    expectSourcePublished(result.actions, 'safety');
  });

  it('forces minimum even when house mode would also override', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      'sensor.house_active_mode': { state: 'sleep' },
    });
    expect(result.reason).toBe('safety_window_open');
    expectModePublished(result.actions, 'minimum');
  });
});

describe('safety — house heating disabled (forceMinimum)', () => {
  it('forces minimum when house_heating_enabled is off', () => {
    const result = run({ 'input_boolean.house_heating_enabled': { state: 'off' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('safety_heating_disabled');
    expectModePublished(result.actions, 'minimum');
    expectSourcePublished(result.actions, 'safety');
  });

  it('window open takes precedence over forceMinimum', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      'input_boolean.house_heating_enabled': { state: 'off' },
    });
    expect(result.reason).toBe('safety_window_open');
  });

  it('does not force minimum when independent flag is set', () => {
    const independentConfig: HeatingRoomConfig = { ...baseConfig, independent: true };
    const result = run({ 'input_boolean.house_heating_enabled': { state: 'off' } }, independentConfig);
    expect(result.reason).not.toBe('safety_heating_disabled');
  });
});

// ---- Stage 3: house mode ----

describe('house mode overrides', () => {
  it('sleep mode maps to baseline_night', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'sleep' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('house_mode_sleep');
    expectModePublished(result.actions, 'baseline_night');
    expectSourcePublished(result.actions, 'house_mode');
  });

  it('away mode maps to minimum', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'away' } });
    expect(result.reason).toBe('house_mode_away');
    expectModePublished(result.actions, 'minimum');
  });

  it('vacation mode maps to minimum', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'vacation' } });
    expect(result.reason).toBe('house_mode_vacation');
    expectModePublished(result.actions, 'minimum');
  });

  it('normal house mode does not override schedule', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'normal' } });
    expect(result.reason).not.toMatch(/^house_mode/);
  });

  it('guest house mode does not override schedule', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'guest' } });
    expect(result.reason).not.toMatch(/^house_mode/);
  });
});

// ---- Stage 4: manual override ----

describe('manual override', () => {
  it('applies the selected manual mode', () => {
    const result = run({ [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('manual_override');
    expectModePublished(result.actions, 'comfort');
    expectSourcePublished(result.actions, 'manual');
  });

  it('sets a manual expiry timer at the next schedule boundary', () => {
    // Wednesday 10:00 — current block ends at 16:00 (6 hours away)
    const result = run({ [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' } });
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('manual'));
    expect(timer).toBeDefined();
    expect((timer as any).delayMs).toBeCloseTo(6 * 60 * 60 * 1000, -3); // ~6h in ms
  });

  it('cancels manual expiry timer when manual is auto (not active)', () => {
    const result = run(); // default is auto
    const cancel = result.actions.find(a => a.type === 'timer.cancel' && (a as any).timerKey.includes('manual'));
    expect(cancel).toBeDefined();
  });

  it('manual override takes precedence over schedule', () => {
    // At 10:00 schedule says baseline_day; manual says comfort
    const result = run({ [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'baseline_night' } });
    expectModePublished(result.actions, 'baseline_night');
  });

  it('safety takes precedence over manual override', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
    });
    expectModePublished(result.actions, 'minimum');
    expect(result.reason).toBe('safety_window_open');
  });

  it('house mode takes precedence over manual override', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
      'sensor.house_active_mode': { state: 'away' },
    });
    expectModePublished(result.actions, 'minimum');
    expect(result.reason).toBe('house_mode_away');
  });

  it('treats unrecognised manual mode value as auto (falls through to schedule)', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'unknown' },
      [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' },
    });
    expectModePublished(result.actions, 'baseline_day');
    expect(result.reason).toBe('schedule');
  });
});

// ---- Stage 5: schedule resolution ----

describe('schedule resolution', () => {
  it('resolves baseline_day block on a weekday morning', () => {
    // Wednesday 10:00 — in 06:00–16:00 block
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }); // force a mode change
    expectModePublished(result.actions, 'baseline_day');
    expectSourcePublished(result.actions, 'schedule');
  });

  it('resolves comfort block on a weekday evening', () => {
    pinTime('2026-01-07T18:00:00.000Z'); // Wednesday 18:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'comfort');
  });

  it('resolves baseline_night for overnight block', () => {
    pinTime('2026-01-07T23:00:00.000Z'); // Wednesday 23:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'baseline_night');
  });

  it('resolves overnight block correctly past midnight', () => {
    pinTime('2026-01-08T02:00:00.000Z'); // Thursday 02:00 — overnight from Wednesday
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'baseline_night');
  });

  it('uses weekend schedule on a Saturday', () => {
    pinTime('2026-01-10T14:00:00.000Z'); // Saturday 14:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'comfort'); // weekend 06:00–22:00 = comfort
  });

  it('prefers weekday_wfh_adam context when wfh_adam is on on a weekday', () => {
    const wfhConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: {
        byContext: {
          weekday_wfh_adam: [{ start: '06:00', end: '22:00', mode: 'comfort' }],
          weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day' }],
          default: [],
        },
      },
    };
    const result = run(
      { 'input_boolean.wfh_adam': { state: 'on' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      wfhConfig,
    );
    expectModePublished(result.actions, 'comfort');
  });

  it('falls back to weekday context when wfh_adam is off', () => {
    const wfhConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: {
        byContext: {
          weekday_wfh_adam: [{ start: '06:00', end: '22:00', mode: 'comfort' }],
          weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day' }],
          default: [],
        },
      },
    };
    const result = run(
      { 'input_boolean.wfh_adam': { state: 'off' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      wfhConfig,
    );
    expectModePublished(result.actions, 'baseline_day');
  });

  it('returns no_action when no schedule block matches', () => {
    const sparseConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: { byContext: { default: [] } }, // no blocks
    };
    const result = run({}, sparseConfig);
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('no_schedule_match');
  });

  it('plans a schedule boundary timer for the next block end', () => {
    // Wednesday 10:00 — block ends at 16:00 (6h away)
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('schedule'));
    expect(timer).toBeDefined();
    expect((timer as any).delayMs).toBeCloseTo(6 * 60 * 60 * 1000, -3);
  });
});

// ---- Stage 5: occupancy upgrade ----

describe('occupancy upgrade', () => {
  const occupancyConfig: HeatingRoomConfig = {
    location: LOCATION,
    scheduleConfig: {
      byContext: {
        weekday: [
          { start: '06:00', end: '16:00', mode: 'baseline_day', occupiedMode: 'comfort' },
          { start: '16:00', end: '22:00', mode: 'comfort' },
          { start: '22:00', end: '06:00', mode: 'baseline_night' },
        ],
      },
    },
  };

  it('upgrades to occupiedMode when room is occupied', () => {
    const result = run(
      { [`sensor.${LOCATION}_occupied`]: { state: 'occupied' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'comfort');
    expect(result.reason).toBe('schedule_occupied');
  });

  it('uses base mode when room is unoccupied', () => {
    const result = run(
      { [`sensor.${LOCATION}_occupied`]: { state: 'unoccupied' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'baseline_day');
    expect(result.reason).toBe('schedule');
  });

  it('ignores occupiedMode when not set on the block', () => {
    // 16:00 block has no occupiedMode
    pinTime('2026-01-07T18:00:00.000Z');
    const result = run(
      { [`sensor.${LOCATION}_occupied`]: { state: 'occupied' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'comfort');
    expect(result.reason).toBe('schedule');
  });

  it('safety overrides occupied mode', () => {
    const result = run(
      {
        [`sensor.${LOCATION}_occupied`]: { state: 'occupied' },
        [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'minimum');
    expect(result.reason).toBe('safety_window_open');
  });

  it('manual override takes precedence over occupied mode', () => {
    const result = run(
      {
        [`sensor.${LOCATION}_occupied`]: { state: 'occupied' },
        [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'baseline_night' },
        [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' },
      },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'baseline_night');
    expect(result.reason).toBe('manual_override');
  });
});

// ---- Stage 7: no-op detection ----

describe('no-op detection', () => {
  it('returns maintain when mode is already correct', () => {
    // baseState has active_heating = baseline_day, and schedule at 10:00 = baseline_day
    const result = run();
    expect(result.decision).toBe('maintain');
    expect(result.reason).toBe('no_change');
  });

  it('still plans the schedule timer when maintaining', () => {
    const result = run();
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('schedule'));
    expect(timer).toBeDefined();
  });

  it('does not publish MQTT when maintaining', () => {
    const result = run();
    const publishes = result.actions.filter(a => a.type === 'mqtt.publish');
    expect(publishes).toHaveLength(0);
  });
});

// ---- Observability: inputs snapshot ----

describe('inputs snapshot', () => {
  it('includes all decision-relevant values', () => {
    const result = run();
    expect(result.inputs).toMatchObject({
      automationEnabled: true,
      windowOpen: false,
      forceMinimum: false,
      houseMode: 'normal',
      manualMode: null,
      weekday: true,
    });
  });
});

// ---- Helpers ----

function expectModePublished(actions: Action[], mode: string) {
  const pub = actions.find(
    a => a.type === 'mqtt.publish' && (a as any).topic === `${LOCATION}/heating/active`,
  );
  expect(pub).toBeDefined();
  expect((pub as any).payload).toBe(mode);
  expect((pub as any).retain).toBe(true);
}

function expectSourcePublished(actions: Action[], source: string) {
  const pub = actions.find(
    a => a.type === 'mqtt.publish' && (a as any).topic === `${LOCATION}/heating/source`,
  );
  expect(pub).toBeDefined();
  expect((pub as any).payload).toBe(source);
}

type Action = { type: string; [key: string]: unknown };
