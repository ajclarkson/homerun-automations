import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import shower from './shower.js';
import { HUMIDITY_WINDOWS } from './fixtures/humidity-windows.js';
import { HELPERS, replay, statsAt, windowAt, type ReplayResult } from './shower-replay.js';

const H = 'sensor.bathroom_sensor_climate_humidity';
const CHANGE = 'sensor.bathroom_humidity_change_5m';
const MAX = 'sensor.bathroom_humidity_max_10m';
const SHOWER = 'binary_sensor.bathroom_shower';
const MAX_ON = 'bathroom:shower:max_on';
const CONFIRM = 'bathroom:shower:end_confirm';
const MIN = 60_000;

const stateChanged = (entity: string, from: string, to: string) => ({
  type: 'state_changed' as const, entity_id: entity,
  old_state: { entity_id: entity, state: from, attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'c',
});
const timer = (timerKey: string) => ({ type: 'timer_expired' as const, timerKey, correlation_id: 'c' });
const onStart = { type: 'on_start' as const, correlation_id: 'c' };

const baseState = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    [H]: '70', [CHANGE]: '0', [MAX]: '70', [SHOWER]: 'off',
    'input_number.bathroom_automation_shower_rise': '4',
    'input_number.bathroom_automation_shower_end_drop': '3',
    'input_number.bathroom_automation_shower_end_confirm': '5',
    ...over,
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { state: v }]));
};

const publish = (payload: 'ON' | 'OFF') =>
  ({ type: 'mqtt.publish', topic: 'bathroom/shower/state', payload, retain: true, impliesEntity: SHOWER });

describe('shower detection', () => {
  it('starts a shower when humidity climbs at least the rise threshold in 5 minutes', () => {
    const r = testAutomation(shower, { event: stateChanged(CHANGE, '0', '6'), state: baseState({ [CHANGE]: '6' }) });
    expect(r).toMatchObject({ decision: 'set_on', reason: 'shower_started' });
    expect(r.actions).toContainEqual(publish('ON'));
    expect(r.actions).toContainEqual({ type: 'timer.start', timerKey: MAX_ON, delayMs: 45 * MIN });
  });

  it('ignores slow drift below the rise threshold', () => {
    const r = testAutomation(shower, { event: stateChanged(CHANGE, '0', '1.3'), state: baseState({ [CHANGE]: '1.3' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'no_shower', actions: [] });
  });

  it('waits for the statistic events before judging a rise, because the statistics lag the humidity report', () => {
    const r = testAutomation(shower, { event: stateChanged(H, '70', '80'), state: baseState({ [H]: '80', [CHANGE]: '9' }) });
    expect(r.reason).toBe('no_shower');
  });

  it('reports a shower already running as running', () => {
    const r = testAutomation(shower, { event: stateChanged(CHANGE, '9', '5'), state: baseState({ [SHOWER]: 'on', [H]: '92', [CHANGE]: '5', [MAX]: '92' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'shower_running' });
  });
});

describe('shower end', () => {
  const falling = { [SHOWER]: 'on', [H]: '88', [MAX]: '93', [CHANGE]: '-3' };

  it('starts the end-confirm timer when humidity first falls the drop below the peak', () => {
    const r = testAutomation(shower, { event: stateChanged(H, '91', '88'), state: baseState(falling) });
    expect(r).toMatchObject({ reason: 'shower_end_pending' });
    expect(r.actions).toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 5 * MIN }]);
  });

  it('does not restart the timer on later reports while the fall continues', () => {
    const r = testAutomation(shower, { event: stateChanged(H, '88', '86'), state: baseState({ ...falling, [H]: '86' }) });
    expect(r).toMatchObject({ reason: 'shower_end_pending', actions: [] });
  });

  it('does not treat a fall smaller than the drop as the end', () => {
    const r = testAutomation(shower, { event: stateChanged(H, '93', '91'), state: baseState({ ...falling, [H]: '91' }) });
    expect(r).toMatchObject({ reason: 'shower_running', actions: [] });
  });

  it('cancels the pending end when humidity climbs again (stepped out of the water, then back in)', () => {
    const r = testAutomation(shower, { event: stateChanged(CHANGE, '-3', '4.5'), state: baseState({ ...falling, [H]: '89', [CHANGE]: '4.5' }) });
    expect(r).toMatchObject({ reason: 'shower_resumed' });
    expect(r.actions).toEqual([{ type: 'timer.cancel', timerKey: CONFIRM }]);
  });

  it('publishes OFF when end-confirm expires with humidity not climbing', () => {
    const r = testAutomation(shower, { event: timer(CONFIRM), state: baseState({ ...falling, [CHANGE]: '0' }) });
    expect(r).toMatchObject({ decision: 'set_off', reason: 'shower_ended' });
    expect(r.actions).toContainEqual(publish('OFF'));
    expect(r.actions).toContainEqual({ type: 'timer.cancel', timerKey: MAX_ON });
  });

  it('keeps the shower on when end-confirm expires but humidity is climbing', () => {
    const r = testAutomation(shower, { event: timer(CONFIRM), state: baseState({ ...falling, [CHANGE]: '5' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'shower_running' });
  });

  it('forces OFF at the 45 minute cap whatever the humidity says', () => {
    const r = testAutomation(shower, { event: timer(MAX_ON), state: baseState({ [SHOWER]: 'on', [H]: '95', [MAX]: '95', [CHANGE]: '0' }) });
    expect(r).toMatchObject({ decision: 'set_off', reason: 'shower_max_duration' });
    expect(r.actions).toContainEqual(publish('OFF'));
  });

  it('ignores stray timers when no shower is running', () => {
    expect(testAutomation(shower, { event: timer(MAX_ON), state: baseState() }).reason).toBe('no_shower');
    expect(testAutomation(shower, { event: timer(CONFIRM), state: baseState() }).reason).toBe('no_shower');
  });

  it('re-arms the cap after a restart so a stale ON cannot stick', () => {
    const r = testAutomation(shower, { event: onStart, state: baseState({ [SHOWER]: 'on', [H]: '90', [MAX]: '90' }) });
    expect(r.actions).toContainEqual({ type: 'timer.start', timerKey: MAX_ON, delayMs: 45 * MIN });
  });
});

describe('threshold clamps', () => {
  it('clamps an over-long end-confirm helper to 10 minutes', () => {
    const r = testAutomation(shower, {
      event: stateChanged(H, '91', '88'),
      state: baseState({ [SHOWER]: 'on', [H]: '88', [MAX]: '93', 'input_number.bathroom_automation_shower_end_confirm': '90' }),
    });
    expect(r.actions).toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 10 * MIN }]);
  });

  it('clamps an end-confirm helper below 2 minutes up to 2', () => {
    const r = testAutomation(shower, {
      event: stateChanged(H, '91', '88'),
      state: baseState({ [SHOWER]: 'on', [H]: '88', [MAX]: '93', 'input_number.bathroom_automation_shower_end_confirm': '0' }),
    });
    expect(r.actions).toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 2 * MIN }]);
  });

  it('clamps a rise threshold of 0 up to 2 so quiet drift cannot start a shower', () => {
    const state = baseState({ [CHANGE]: '1.3', 'input_number.bathroom_automation_shower_rise': '0' });
    expect(testAutomation(shower, { event: stateChanged(CHANGE, '0', '1.3'), state }).reason).toBe('no_shower');
  });

  it('clamps a rise threshold of 50 down to 6 so a real shower is still found', () => {
    const state = baseState({ [CHANGE]: '7', 'input_number.bathroom_automation_shower_rise': '50' });
    expect(testAutomation(shower, { event: stateChanged(CHANGE, '0', '7'), state }).reason).toBe('shower_started');
  });

  it('clamps an end drop of 0 up to 1 so sensor noise is not a fall', () => {
    const state = baseState({ [SHOWER]: 'on', [H]: '92.5', [MAX]: '93', 'input_number.bathroom_automation_shower_end_drop': '0' });
    expect(testAutomation(shower, { event: stateChanged(H, '93', '92.5'), state }).reason).toBe('shower_running');
  });
});

describe('bad inputs abort loudly', () => {
  const aborts = (over: Record<string, string>) =>
    testAbort(shower, { event: stateChanged(CHANGE, '0', '1'), state: baseState(over) }).reason;

  it.each([
    ['humidity unavailable', { [H]: 'unavailable' }, `humidity_unavailable:${H}`],
    ['humidity above 100', { [H]: '140' }, `humidity_unavailable:${H}`],
    ['humidity negative', { [H]: '-4' }, `humidity_unavailable:${H}`],
    ['max_10m unknown', { [MAX]: 'unknown' }, `humidity_unavailable:${MAX}`],
    ['change_5m unknown (never read as zero)', { [CHANGE]: 'unknown' }, `humidity_unavailable:${CHANGE}`],
    ['change_5m unavailable', { [CHANGE]: 'unavailable' }, `humidity_unavailable:${CHANGE}`],
    ['rise helper unavailable', { 'input_number.bathroom_automation_shower_rise': 'unavailable' }, 'helper_unavailable:input_number.bathroom_automation_shower_rise'],
    ['shower entity unavailable', { [SHOWER]: 'unavailable' }, 'shower_state_unavailable:unavailable'],
  ])('%s', (_name, over, reason) => {
    expect(aborts(over)).toBe(reason);
  });

  it('treats a never-published shower sensor (unknown) as off, the normal state before the first shower', () => {
    const r = testAutomation(shower, { event: stateChanged(CHANGE, '0', '1'), state: baseState({ [SHOWER]: 'unknown' }) });
    expect(r.reason).toBe('no_shower');
  });
});

describe('statistics model (matches homeassistant statistics)', () => {
  it('reports change 0 for a one-sample window, keeping the last sample', () => {
    expect(statsAt([[0, 60], [900, 70]], 900).change).toBe(0);
    expect(windowAt([[0, 60]], 5000, 600)).toEqual([60]);
  });
  it('purges samples strictly older than max_age after adding the new one', () => {
    expect(windowAt([[0, 60], [300, 64], [301, 66]], 301, 300)).toEqual([64, 66]);
  });
});

// ---------- Replay of recorded showers ----------

const SECOND_RISE_WINDOWS = ['shower_24_oct_1541_second_rise_1601', 'shower_28_oct_0724_second_rise_0750'];
const named = (n: string) => HUMIDITY_WINDOWS.find((w) => w.name === n)!;
const starts = (r: ReplayResult) => r.published.filter((p) => p.payload === 'ON').map((p) => p.atS / 60);
const ends = (r: ReplayResult) => r.published.filter((p) => p.payload === 'OFF').map((p) => p.atS / 60);

describe('replay of recorded showers (plan defaults: rise 4, drop 3, confirm 5)', () => {
  const showers = HUMIDITY_WINDOWS.filter((w) => w.name.startsWith('shower_'));
  // 27 Oct is covered by its own expected-failure test below.
  const detectable = showers.filter((w) => w.name !== 'shower_27_oct_0647');

  it.each(detectable.map((w) => [w.name, w] as const))('%s is detected and ended, and never left on', (_n, w) => {
    const r = replay(w);
    expect(starts(r).length).toBeGreaterThanOrEqual(1);
    expect(r.published.at(-1)!.payload).toBe('OFF');
    // Ends within 35 min of the first detection: a 27 min shower plus the 5 min confirm plus a report gap.
    starts(r).forEach((s, i) => expect(ends(r)[i]! - s).toBeLessThanOrEqual(35));
    expect(r.published.some((p) => p.reason === 'shower_max_duration')).toBe(false);
  });

  it('detects the 24 Oct second rise as a second shower after the first has ended', () => {
    const r = replay(named('shower_24_oct_1541_second_rise_1601'));
    expect(starts(r)).toHaveLength(2);
    expect(starts(r)[1]).toBeGreaterThan(ends(r)[0]!);
  });

  // Plan claim: every shower clears 4 points in 5 minutes. On 27 Oct the sensor reported
  // 75.6 then 82.6 after a 5.0 min gap, so HA's 5-min window purges the earlier sample
  // and change_5m never exceeds 1.2. Recorded here as a known disagreement.
  it.fails('detects 27 Oct 06:47 (change_5m peaks at 1.2 under HA windowing)', () => {
    expect(starts(replay(named('shower_27_oct_0647'))).length).toBeGreaterThanOrEqual(1);
  });

  // Plan claim: the second rise on 28 Oct clears 4. Under HA windowing it peaks at 2.9.
  it.fails('detects the 28 Oct 07:50 second rise (change_5m peaks at 2.9)', () => {
    expect(starts(replay(named('shower_28_oct_0724_second_rise_0750')))).toHaveLength(2);
  });

  // Plan claim: the 25 Oct 11:51 drift never clears 4. Under HA windowing change_5m reaches 4.9.
  it.fails('does not detect the 25 Oct 11:51 drift at rise 4 (change_5m reaches 4.9)', () => {
    expect(starts(replay(named('false_positive_25_oct_1151')))).toHaveLength(0);
  });

  it('does not detect the 25 Oct 11:51 drift at rise 5, and still detects every shower first start', () => {
    const helpers = { ...HELPERS, 'input_number.bathroom_automation_shower_rise': { state: '5' } };
    expect(starts(replay(named('false_positive_25_oct_1151'), helpers))).toHaveLength(0);
    for (const w of detectable) expect(starts(replay(w, helpers)).length).toBeGreaterThanOrEqual(1);
  });

  it('keeps the mid-shower dip from ending a shower before the confirm window has passed', () => {
    for (const name of SECOND_RISE_WINDOWS) {
      const r = replay(named(name));
      expect(ends(r)[0]! - starts(r)[0]!).toBeGreaterThanOrEqual(5);
    }
  });
});
