import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from './declared-outcome.js';
import { makeHeatingAutomation, causeOf, assertValidPlanBlocks, type HeatingPlan, type HeatingRoomConfig, type HeatingCause } from './heating-controller-factory.js';

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
  [`binary_sensor.${LOCATION}_occupied`]: { state: 'off' },
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
  overrideState: Record<string, { state: string; last_changed?: string; attributes?: Record<string, unknown> }> = {},
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
    expect(result.outcome).toBe('ignored');
    expect(result.actions).toEqual([]);
  });
});

// ---- Stage 2: safety overrides ----

describe('safety — window open', () => {
  it('forces minimum regardless of schedule', () => {
    const result = run({ [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
    expectSourcePublished(result.actions, 'safety');
  });

  it('forces minimum even when house mode would also override', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      'sensor.house_active_mode': { state: 'sleep' },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
  });
});

describe('safety — window open grace period', () => {
  const GRACE_HELPER = 'input_number.global_heating_window_open_grace_minutes';
  // Pinned time is 2026-01-07T10:00:00.000Z.
  const justOpened = '2026-01-07T10:00:00.000Z';
  const openedFiveMinAgo = '2026-01-07T09:55:00.000Z';

  it('does not force minimum while the window has been open less than the grace period', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: justOpened },
      [GRACE_HELPER]: { state: '2' },
    });
    expect(result.reason).not.toBe('safety_window_open');
  });

  it('starts a grace timer for the remaining time while the window is pending', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: justOpened },
      [GRACE_HELPER]: { state: '2' },
    });
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('window_open_grace'));
    expect(timer).toBeDefined();
    expect((timer as any).delayMs).toBeCloseTo(2 * 60 * 1000, -2);
  });

  it('forces minimum once the window has been open at least as long as the grace period', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: openedFiveMinAgo },
      [GRACE_HELPER]: { state: '2' },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
  });

  it('cancels the grace timer once the window closes', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'off' },
      [GRACE_HELPER]: { state: '2' },
    });
    const cancel = result.actions.find(a => a.type === 'timer.cancel' && (a as any).timerKey.includes('window_open_grace'));
    expect(cancel).toBeDefined();
  });

  it('cancels the grace timer once the window has been open long enough to confirm', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: openedFiveMinAgo },
      [GRACE_HELPER]: { state: '2' },
    });
    const cancel = result.actions.find(a => a.type === 'timer.cancel' && (a as any).timerKey.includes('window_open_grace'));
    expect(cancel).toBeDefined();
  });

  it('forces minimum immediately when the grace helper is unavailable, failing toward the stricter behaviour', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: justOpened },
      [GRACE_HELPER]: { state: 'unavailable' },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
  });

  it('forces minimum immediately when the open-since timestamp is unknown, failing toward the stricter behaviour', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' }, // no last_changed
      [GRACE_HELPER]: { state: '2' },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
  });

  it('clamps an excessive grace value to MAX_WINDOW_GRACE_MINUTES', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: justOpened },
      [GRACE_HELPER]: { state: '999' },
    });
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('window_open_grace'));
    expect((timer as any).delayMs).toBeCloseTo(30 * 60 * 1000, -2);
  });

  it('re-evaluates and forces minimum when the grace timer expires with the window still open', () => {
    const automation = makeHeatingAutomation(baseConfig);
    const result = testAutomation(automation, {
      event: { type: 'timer_expired', timerKey: `${LOCATION}:heating:window_open_grace`, correlation_id: 'test-cid' },
      state: {
        ...baseState,
        [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: openedFiveMinAgo },
        [GRACE_HELPER]: { state: '2' },
      },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
  });
});

describe('safety — house heating disabled (forceMinimum)', () => {
  it('forces minimum when house_heating_enabled is off', () => {
    const result = run({ 'input_boolean.house_heating_enabled': { state: 'off' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('safety_heating_disabled');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
    expectSourcePublished(result.actions, 'safety');
  });

  it('window open takes precedence over forceMinimum', () => {
    const result = run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      'input_boolean.house_heating_enabled': { state: 'off' },
    });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
  });

  it('does not force minimum when independent flag is set', () => {
    const independentConfig: HeatingRoomConfig = { ...baseConfig, independent: true };
    const result = run({ 'input_boolean.house_heating_enabled': { state: 'off' } }, independentConfig);
    expect(result.reason).not.toBe('safety_heating_disabled');
  });
});

describe('independent rooms opt out of house mode overrides', () => {
  const independentConfig: HeatingRoomConfig = { ...baseConfig, independent: true };

  it('keeps following its own schedule when the house enters sleep mode', () => {
    const result = run(
      { 'sensor.house_active_mode': { state: 'sleep' }, [`sensor.${LOCATION}_active_heating`]: { state: 'comfort' } },
      independentConfig,
    );
    expect(result.reason).not.toMatch(/^house_mode/);
    expect(result.reason).toBe('schedule');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
  });

  it('keeps following its own schedule when the house enters away mode', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'away' } }, independentConfig);
    expect(result.reason).not.toMatch(/^house_mode/);
  });

  it('keeps following its own schedule when the house enters vacation mode', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'vacation' } }, independentConfig);
    expect(result.reason).not.toMatch(/^house_mode/);
  });

  it('a non-independent room in the same house mode is still overridden', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'sleep' } }, baseConfig);
    expect(result.reason).toBe('house_mode_sleep');
    expect(result.outcome).toBe('acted');
  });
});

// ---- Stage 3: house mode ----

describe('house mode overrides', () => {
  it('sleep mode maps to baseline_night', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'sleep' } });
    expect(result.decision).toBe('set_mode');
    expect(result.reason).toBe('house_mode_sleep');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
    expectSourcePublished(result.actions, 'house_mode');
  });

  it('away mode maps to baseline_night, not minimum, so the cat is not left in a cold house', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'away' } });
    expect(result.reason).toBe('house_mode_away');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
  });

  it('vacation mode maps to minimum', () => {
    const result = run({ 'sensor.house_active_mode': { state: 'vacation' } });
    expect(result.reason).toBe('house_mode_vacation');
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
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
    expect(result.outcome).toBe('acted');
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' });
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

  it('resets input_select to auto and falls through to schedule when manual timer expires', () => {
    const automation = makeHeatingAutomation(baseConfig);
    const result = testAutomation(automation, {
      event: { type: 'timer_expired', timerKey: `${LOCATION}:heating:manual_override_expiry`, correlation_id: 'test-cid' },
      state: {
        ...baseState,
        [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
        [`sensor.${LOCATION}_active_heating`]: { state: 'comfort' },
      },
    });
    const reset = result.actions.find(
      a => a.type === 'ha.call_service' && (a as any).domain === 'input_select' && (a as any).service === 'select_option',
    );
    expect(reset).toBeDefined();
    expect((reset as any).data?.option).toBe('auto');
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
    expect(result.reason).toBe('schedule');
    expect(result.outcome).toBe('acted');
  });

  it('manual override takes precedence over schedule', () => {
    // At 10:00 schedule says baseline_day; manual says comfort
    const result = run({ [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'baseline_night' } });
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
  });

  it('safety takes precedence over manual override', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
    });
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
  });

  it('house mode takes precedence over manual override', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
      'sensor.house_active_mode': { state: 'away' },
    });
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
    expect(result.reason).toBe('house_mode_away');
    expect(result.outcome).toBe('acted');
  });

  it('treats unrecognised manual mode value as auto (falls through to schedule)', () => {
    const result = run({
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'unknown' },
      [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' },
    });
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
    expect(result.reason).toBe('schedule');
    expect(result.outcome).toBe('acted');
  });
});

// ---- Stage 5: schedule resolution ----

describe('schedule resolution', () => {
  it('resolves baseline_day block on a weekday morning', () => {
    // Wednesday 10:00 — in 06:00–16:00 block
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }); // force a mode change
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
    expectSourcePublished(result.actions, 'schedule');
  });

  it('resolves comfort block on a weekday evening', () => {
    pinTime('2026-01-07T18:00:00.000Z'); // Wednesday 18:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' });
  });

  it('resolves baseline_night for overnight block', () => {
    pinTime('2026-01-07T23:00:00.000Z'); // Wednesday 23:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
  });

  it('resolves overnight block correctly past midnight', () => {
    pinTime('2026-01-08T02:00:00.000Z'); // Thursday 02:00 — overnight from Wednesday
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
  });

  it('uses weekend schedule on a Saturday', () => {
    pinTime('2026-01-10T14:00:00.000Z'); // Saturday 14:00
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' }); // weekend 06:00–22:00 = comfort
  });

  it('prefers weekday_wfh_adam context when wfh_adam is on on a weekday', () => {
    const wfhConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: {
        byContext: {
          weekday_wfh_adam: [{ start: '06:00', end: '22:00', mode: 'comfort' }],
          weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day' }],
          default: [{ start: '01:00', end: '02:00', mode: 'minimum' }],
        },
      },
    };
    const result = run(
      { 'input_boolean.wfh_adam': { state: 'on' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      wfhConfig,
    );
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' });
  });

  it('falls back to weekday context when wfh_adam is off', () => {
    const wfhConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: {
        byContext: {
          weekday_wfh_adam: [{ start: '06:00', end: '22:00', mode: 'comfort' }],
          weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day' }],
          default: [{ start: '01:00', end: '02:00', mode: 'minimum' }],
        },
      },
    };
    const result = run(
      { 'input_boolean.wfh_adam': { state: 'off' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      wfhConfig,
    );
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
  });

  it('returns no_action when no schedule block matches', () => {
    const sparseConfig: HeatingRoomConfig = {
      location: LOCATION,
      scheduleConfig: { byContext: { default: [{ start: '01:00', end: '02:00', mode: 'minimum' }] } }, // no block covers 10:00
    };
    const result = run({}, sparseConfig);
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('no_schedule_match');
    expect(result.outcome).toBe('ignored');
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
      { [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' });
    expect(result.reason).toBe('schedule_occupied');
    expect(result.outcome).toBe('acted');
  });

  it('uses base mode when room is unoccupied', () => {
    const result = run(
      { [`binary_sensor.${LOCATION}_occupied`]: { state: 'off' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'baseline_day');
    expect(result.facts).toMatchObject({ mode: 'baseline_day' });
    expect(result.reason).toBe('schedule');
    expect(result.outcome).toBe('acted');
  });

  it('ignores occupiedMode when not set on the block', () => {
    // 16:00 block has no occupiedMode
    pinTime('2026-01-07T18:00:00.000Z');
    const result = run(
      { [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'comfort');
    expect(result.facts).toMatchObject({ mode: 'comfort' });
    expect(result.reason).toBe('schedule');
    expect(result.outcome).toBe('acted');
  });

  it('safety overrides occupied mode', () => {
    const result = run(
      {
        [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
        [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' },
      },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'minimum');
    expect(result.facts).toMatchObject({ mode: 'minimum' });
    expect(result.reason).toBe('safety_window_open');
    expect(result.outcome).toBe('acted');
  });

  it('manual override takes precedence over occupied mode', () => {
    const result = run(
      {
        [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
        [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'baseline_night' },
        [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' },
      },
      occupancyConfig,
    );
    expectModePublished(result.actions, 'baseline_night');
    expect(result.facts).toMatchObject({ mode: 'baseline_night' });
    expect(result.reason).toBe('manual_override');
    expect(result.outcome).toBe('acted');
  });
});

// ---- Stage 7: no-op detection ----

describe('no-op detection', () => {
  it('returns maintain when mode is already correct', () => {
    // baseState has active_heating = baseline_day, and schedule at 10:00 = baseline_day
    const result = run();
    expect(result.decision).toBe('maintain');
    expect(result.reason).toBe('no_change');
    expect(result.outcome).toBe('ignored');
  });

  it('still plans the schedule timer when maintaining', () => {
    const result = run();
    const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey.includes('schedule'));
    expect(timer).toBeDefined();
  });

  it('does not republish mode or source when maintaining', () => {
    const result = run();
    const publishes = result.actions.filter(a => a.type === 'mqtt.publish' && !(a as any).topic.endsWith('/heating/plan'));
    expect(publishes).toHaveLength(0);
  });
});

// ---- Observability: conditions snapshot ----

describe('conditions snapshot', () => {
  it('includes all decision-relevant values', () => {
    const result = run();
    expect(result.conditions).toMatchObject({
      automationEnabled: true,
      safety: { windowOpen: false, forceMinimum: false },
      house: { mode: 'normal' },
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
  expect((pub as any).impliesEntity).toBe(`sensor.${LOCATION}_active_heating`);
}

function expectSourcePublished(actions: Action[], source: string) {
  const pub = actions.find(
    a => a.type === 'mqtt.publish' && (a as any).topic === `${LOCATION}/heating/source`,
  );
  expect(pub).toBeDefined();
  expect((pub as any).payload).toBe(source);
  expect((pub as any).impliesEntity).toBe(`sensor.${LOCATION}_heating_source`);
}

// Only `type` is read directly; the homerun Action interfaces have no index signature.
type Action = { type: string };

// ---- Cause: what set the decision off ----

describe('the cause carried with a mode change', () => {
  const stateEvent = (entity_id: string, to: string) => ({
    type: 'state_changed' as const,
    entity_id,
    old_state: { entity_id, state: 'x', attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id, state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  });
  const timerEvent = (suffix: string) => ({ type: 'timer_expired' as const, timerKey: `${LOCATION}:heating:${suffix}`, correlation_id: 'test-cid' });
  const exec = (event: Parameters<typeof testAutomation>[1]['event'], overrideState: Record<string, { state: string }> = {}) =>
    testAutomation(makeHeatingAutomation(baseConfig), { event, state: { ...baseState, ...overrideState } });

  // Each case changes the mode (the baseline_day starting point differs from the target), so the
  // decision is a set_mode and carries the cause.
  const cases: [HeatingCause, Parameters<typeof testAutomation>[1]['event'], Record<string, { state: string }>, string][] = [
    ['startup', onStartEvent, { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['boundary', timerEvent('schedule_boundary'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['window_closed', stateEvent(`binary_sensor.${LOCATION}_external_openings`, 'off'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['house_mode', stateEvent('sensor.house_active_mode', 'sleep'), { 'sensor.house_active_mode': { state: 'sleep' } }, 'house_mode_sleep'],
    ['manual_set', stateEvent(`input_select.${LOCATION}_heating_manual_mode`, 'comfort'), { [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' } }, 'manual_override'],
    ['manual_ended', stateEvent(`input_select.${LOCATION}_heating_manual_mode`, 'auto'), { [`sensor.${LOCATION}_active_heating`]: { state: 'comfort' } }, 'schedule'],
    ['manual_ended', timerEvent('manual_override_expiry'), { [`sensor.${LOCATION}_active_heating`]: { state: 'comfort' } }, 'schedule'],
    ['heating_on', stateEvent('input_boolean.house_heating_enabled', 'on'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['heating_on', stateEvent(`input_boolean.${LOCATION}_automation_heating_enabled`, 'on'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['wfh', stateEvent('input_boolean.wfh_sarah', 'on'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['wfh', stateEvent('input_boolean.wfh_adam', 'off'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
    ['occupancy', stateEvent(`binary_sensor.${LOCATION}_occupied`, 'on'), { [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } }, 'schedule'],
  ];

  it.each(cases)('is %s when %#', (cause, event, overrides, reason) => {
    const result = exec(event, overrides);
    expect(result).toMatchObject({ decision: 'set_mode', reason, outcome: 'acted' });
    expect(result.facts).toMatchObject({ cause });
  });

  it('carries the cause on the occupied schedule reason too', () => {
    const config: HeatingRoomConfig = { location: LOCATION, scheduleConfig: { byContext: { weekday: [{ start: '06:00', end: '16:00', mode: 'baseline_day', occupiedMode: 'comfort' }] } } };
    const result = testAutomation(makeHeatingAutomation(config), {
      event: stateEvent(`binary_sensor.${LOCATION}_occupied`, 'on'),
      state: { ...baseState, [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' }, [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } },
    });
    expect(result).toMatchObject({ reason: 'schedule_occupied' });
    expect(result.facts).toEqual({ mode: 'comfort', cause: 'occupancy' });
  });

  it('leaves the cause off the safety reasons, which explain themselves', () => {
    const result = exec(stateEvent(`binary_sensor.${LOCATION}_external_openings`, 'on'), { [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on' } });
    expect(result).toMatchObject({ reason: 'safety_window_open' });
    expect(result.facts).toEqual({ mode: 'minimum' });
  });

  // `other` is only the runtime fallback so a newly added trigger cannot stop heating deciding.
  // This walks every trigger the factory declares and fails until a new one is mapped.
  it('maps every trigger the automation declares to a real cause, never the fallback', () => {
    const automation = makeHeatingAutomation(baseConfig);
    const unmapped: string[] = [];
    for (const trigger of automation.triggers as { type: string; entity?: string; timerKey?: string }[]) {
      const event = trigger.type === 'state_changed' ? stateEvent(trigger.entity as string, 'on')
        : trigger.type === 'timer_expired' ? { type: 'timer_expired' as const, timerKey: trigger.timerKey as string, correlation_id: 'test-cid' }
        : onStartEvent;
      if (causeOf(event, LOCATION) === 'other') unmapped.push(`${trigger.type}:${trigger.entity ?? trigger.timerKey ?? ''}`);
    }
    expect(unmapped).toEqual([]);
  });

  it('falls back to other for an event it does not know, rather than throwing at runtime', () => {
    expect(causeOf(stateEvent('sensor.something_new', 'on'), LOCATION)).toBe('other');
  });
});

// ---- Day plan published for the Pulse card ----

const PLAN_TOPIC = `${LOCATION}/heating/plan`;
const PLAN_ENTITY = `sensor.${LOCATION}_heating_plan`;

function planOf(actions: { type: string }[]): HeatingPlan | null {
  const pub = actions.find(a => a.type === 'mqtt.publish' && (a as any).topic === PLAN_TOPIC) as any;
  if (!pub) return null;
  expect(pub.retain).toBe(true);
  expect(pub.impliesEntity).toBe(PLAN_ENTITY);
  return JSON.parse(pub.payload) as HeatingPlan;
}

// Tests run in the process's local zone; build instants from local parts so they hold anywhere.
const localIso = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi).toISOString();
const utcNoMs = (iso: string) => iso.replace(/\.\d{3}Z$/, 'Z');

describe('the day plan', () => {
  const WED_10 = localIso(2026, 1, 7, 10, 0);

  beforeEach(() => pinTime(WED_10));

  it('publishes the configured blocks, the context and the local date', () => {
    const plan = planOf(run().actions)!;
    expect(plan.date).toBe('2026-01-07');
    expect(plan.context).toBe('weekday');
    expect(plan.blocks).toEqual([
      { start: '06:00', end: '16:00', mode: 'baseline_day' },
      { start: '16:00', end: '22:00', mode: 'comfort' },
      { start: '22:00', end: '06:00', mode: 'baseline_night' }, // wrap block kept whole
    ]);
  });

  it('has a schedule source, the block end as until, and no override', () => {
    const plan = planOf(run().actions)!;
    expect(plan.active).toEqual({ mode: 'baseline_day', source: 'schedule', until: utcNoMs(localIso(2026, 1, 7, 16, 0)) });
    expect(plan.override).toBeNull();
  });

  it('uses the weekend context at the weekend', () => {
    pinTime(localIso(2026, 1, 10, 10, 0));
    const plan = planOf(run().actions)!;
    expect(plan.context).toBe('weekend');
    expect(plan.active.mode).toBe('comfort');
  });

  it('uses the wfh context when it is chosen', () => {
    const wfh: HeatingRoomConfig = { location: LOCATION, scheduleConfig: { byContext: {
      weekday_wfh_adam: [{ start: '06:00', end: '22:00', mode: 'comfort' }],
      weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day' }],
    } } };
    const plan = planOf(run({ 'input_boolean.wfh_adam': { state: 'on' } }, wfh).actions)!;
    expect(plan.context).toBe('weekday_wfh_adam');
    expect(plan.blocks).toHaveLength(1);
  });

  it('reports a manual choice as the override, ending with the block', () => {
    const plan = planOf(run({ [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' } }).actions)!;
    const until = utcNoMs(localIso(2026, 1, 7, 16, 0));
    expect(plan.active).toEqual({ mode: 'comfort', source: 'manual', until });
    expect(plan.override).toEqual({ mode: 'comfort', until });
  });

  it('reports safety with no end time and no override, even with a manual choice set', () => {
    const plan = planOf(run({
      [`binary_sensor.${LOCATION}_external_openings`]: { state: 'on', last_changed: new Date(Date.now() - 3_600_000).toISOString() },
      [`input_select.${LOCATION}_heating_manual_mode`]: { state: 'comfort' },
    }).actions)!;
    expect(plan.active).toEqual({ mode: 'minimum', source: 'safety', until: null });
    expect(plan.override).toBeNull();
  });

  it('reports house mode with no end time', () => {
    const plan = planOf(run({ 'sensor.house_active_mode': { state: 'away' } }).actions)!;
    expect(plan.active).toEqual({ mode: 'baseline_night', source: 'house_mode', until: null });
  });

  it('carries occupied_mode on blocks that have one, and applies it when occupied', () => {
    const cfg: HeatingRoomConfig = { location: LOCATION, scheduleConfig: { byContext: {
      weekday: [{ start: '06:00', end: '22:00', mode: 'baseline_day', occupiedMode: 'comfort' }, { start: '22:00', end: '06:00', mode: 'minimum' }],
    } } };
    const plan = planOf(run({ [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' } }, cfg).actions)!;
    expect(plan.blocks[0]).toEqual({ start: '06:00', end: '22:00', mode: 'baseline_day', occupied_mode: 'comfort' });
    expect(plan.blocks[1]).not.toHaveProperty('occupied_mode');
    expect(plan.active).toMatchObject({ mode: 'comfort', source: 'schedule' });
  });

  it('includes an independent room (foreign office) with its occupied blocks, ignoring house mode', () => {
    const cfg: HeatingRoomConfig = { location: LOCATION, independent: true, scheduleConfig: { byContext: {
      default: [{ start: '08:00', end: '20:00', mode: 'minimum', occupiedMode: 'comfort' }, { start: '20:00', end: '08:00', mode: 'minimum' }],
    } } };
    const plan = planOf(run({
      'sensor.house_active_mode': { state: 'away' },
      'input_boolean.house_heating_enabled': { state: 'off' },
      [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
    }, cfg).actions)!;
    expect(plan.context).toBe('default');
    expect(plan.active).toMatchObject({ mode: 'comfort', source: 'schedule' });
    expect(plan.blocks[0].occupied_mode).toBe('comfort');
  });

  it('is published when the mode changes too', () => {
    const result = run({ [`sensor.${LOCATION}_active_heating`]: { state: 'minimum' } });
    expect(planOf(result.actions)).not.toBeNull();
    expectModePublished(result.actions, 'baseline_day');
  });

  it('is not published for a room with no schedule context', () => {
    const none: HeatingRoomConfig = { location: LOCATION, scheduleConfig: { byContext: {} } };
    expect(planOf(run({ 'sensor.house_active_mode': { state: 'away' } }, none).actions)).toBeNull();
  });

  describe('dedupe against what HA holds', () => {
    const held = () => {
      const { date, context, blocks, active, override } = planOf(run().actions)!;
      return { date, context, blocks, active, override };
    };

    it('is not republished when the sensor already carries the same plan', () => {
      const attributes = { ...held(), friendly_name: 'Parlour heating plan' }; // HA adds attributes of its own
      expect(planOf(run({ [PLAN_ENTITY]: { state: 'baseline_day', attributes } }).actions)).toBeNull();
    });

    it('is republished when the active choice differs', () => {
      const h = held();
      const attributes = { ...h, active: { ...h.active, source: 'manual' } };
      expect(planOf(run({ [PLAN_ENTITY]: { state: 'baseline_day', attributes } }).actions)).not.toBeNull();
    });

    it('is republished when the held plan is for yesterday', () => {
      const attributes = { ...held(), date: '2026-01-06' };
      expect(planOf(run({ [PLAN_ENTITY]: { state: 'baseline_day', attributes } }).actions)?.date).toBe('2026-01-07');
    });

    it('is republished when the sensor is unknown or has no attributes', () => {
      expect(planOf(run({ [PLAN_ENTITY]: { state: 'unknown' } }).actions)).not.toBeNull();
    });
  });

  describe('midnight rollover', () => {
    const midnightKey = `${LOCATION}:heating:midnight_rollover`;
    const midnightTimer = (actions: { type: string }[]) =>
      actions.find(a => a.type === 'timer.start' && (a as any).timerKey === midnightKey) as any;

    it('is armed for the next local midnight', () => {
      expect(midnightTimer(run().actions).delayMs).toBe(14 * 3_600_000);
    });

    it('is armed even when the plan is unchanged', () => {
      const attributes = (() => { const p = planOf(run().actions)!; return { ...p }; })();
      expect(midnightTimer(run({ [PLAN_ENTITY]: { state: 'x', attributes } }).actions)).toBeDefined();
    });

    it('is not armed while the automation is disabled', () => {
      const r = run({ [`input_boolean.${LOCATION}_automation_heating_enabled`]: { state: 'off' } });
      expect(midnightTimer(r.actions)).toBeUndefined();
    });

    it('publishes the new date and context when the timer fires after midnight', () => {
      // Tue 23:59:59 plan held; the timer fires at Wed 00:00 (weekday both days) so use Fri -> Sat for a context change.
      pinTime(localIso(2026, 1, 9, 23, 59)); // Friday
      const friday = planOf(run({ [`sensor.${LOCATION}_active_heating`]: { state: 'baseline_night' } }).actions)!;
      expect(friday.context).toBe('weekday');

      pinTime(localIso(2026, 1, 10, 0, 0)); // Saturday midnight
      const event = { type: 'timer_expired' as const, timerKey: midnightKey, correlation_id: 'c' };
      const result = testAutomation(makeHeatingAutomation(baseConfig), {
        event,
        state: { ...baseState, [`sensor.${LOCATION}_active_heating`]: { state: 'baseline_night' }, [PLAN_ENTITY]: { state: 'baseline_night', attributes: friday as any } },
      });
      const saturday = planOf(result.actions)!;
      expect(saturday.date).toBe('2026-01-10');
      expect(saturday.context).toBe('weekend');
      expect(result.facts ?? {}).not.toHaveProperty('cause'); // maintained: mode unchanged
    });

    it('fires a little early and re-arms rather than publishing yesterday again', () => {
      pinTime(new Date(new Date(2026, 0, 8, 0, 0).getTime() - 5).toISOString()); // 5ms before midnight
      const t = midnightTimer(run().actions);
      expect(t.delayMs).toBe(250); // clamped minimum, lands after midnight
    });
  });
});

describe('the plan is validated', () => {
  const ok = { start: '06:00', end: '22:00', mode: 'comfort' as const };

  it('accepts valid blocks, including a 24:00 end', () => {
    expect(() => assertValidPlanBlocks([ok, { ...ok, start: '22:00', end: '24:00' }], 'x')).not.toThrow();
  });
  it('rejects no blocks', () => expect(() => assertValidPlanBlocks([], 'x')).toThrow(/no blocks/));
  it('rejects a bad time', () => {
    expect(() => assertValidPlanBlocks([{ ...ok, start: '6:00' }], 'x')).toThrow(/not HH:MM/);
    expect(() => assertValidPlanBlocks([{ ...ok, end: '25:00' }], 'x')).toThrow(/not HH:MM/);
    expect(() => assertValidPlanBlocks([{ ...ok, start: '24:00' }], 'x')).toThrow(/not HH:MM/);
  });
  it('rejects an unknown mode', () => {
    expect(() => assertValidPlanBlocks([{ ...ok, mode: 'toasty' as any }], 'x')).toThrow(/not a heating mode/);
    expect(() => assertValidPlanBlocks([{ ...ok, occupiedMode: 'toasty' as any }], 'x')).toThrow(/occupiedMode/);
  });
  it('fails when the automation is built, not when it runs', () => {
    expect(() => makeHeatingAutomation({ location: LOCATION, scheduleConfig: { byContext: { weekday: [{ ...ok, start: 'soon' }] } } })).toThrow(/not HH:MM/);
  });
});
