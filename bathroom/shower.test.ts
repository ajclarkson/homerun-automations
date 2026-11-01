import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import shower from './shower.js';
import { HUMIDITY_SERIES } from './fixtures/humidity-series.js';
import { HELPERS, replay, windowAt, percentileExclusive, type ReplayResult } from './shower-replay.js';

const H = 'sensor.bathroom_sensor_climate_humidity';
const MAX = 'sensor.bathroom_humidity_max_10m';
const BASELINE = 'sensor.bathroom_humidity_baseline';
const SHOWER = 'binary_sensor.bathroom_shower';
const MAX_ON = 'bathroom:shower:max_on';
const CONFIRM = 'bathroom:shower:end_confirm';
const RISE = 'input_number.bathroom_automation_shower_rise';
const ABOVE = 'input_number.bathroom_automation_shower_above_baseline';
const MIN = 60_000;
const T0 = Date.parse('2026-10-30T08:00:00Z');

/** A humidity report: `from` -> `to`, `gapMins` after the previous one. */
const report = (from: string, to: string, gapMins = 1, lastChanged?: [string, string]) => ({
  type: 'state_changed' as const, entity_id: H,
  old_state: { entity_id: H, state: from, attributes: {}, last_changed: lastChanged?.[0] ?? new Date(T0).toISOString(), last_updated: '' },
  new_state: { entity_id: H, state: to, attributes: {}, last_changed: lastChanged?.[1] ?? new Date(T0 + gapMins * MIN).toISOString(), last_updated: '' },
  correlation_id: 'c',
});
const timer = (timerKey: string) => ({ type: 'timer_expired' as const, timerKey, correlation_id: 'c' });
const onStart = { type: 'on_start' as const, correlation_id: 'c' };

const baseState = (over: Record<string, string> = {}) => {
  const base: Record<string, string> = {
    [H]: '70', [MAX]: '70', [BASELINE]: '60', [SHOWER]: 'off',
    [RISE]: '5', [ABOVE]: '8',
    'input_number.bathroom_automation_shower_end_drop': '3',
    'input_number.bathroom_automation_shower_end_confirm': '5',
    ...over,
  };
  return Object.fromEntries(Object.entries(base).map(([k, v]) => [k, { state: v }]));
};

const publish = (payload: 'ON' | 'OFF') =>
  ({ type: 'mqtt.publish', topic: 'bathroom/shower/state', payload, retain: true, impliesEntity: SHOWER });

describe('shower detection (step between reports)', () => {
  const detect = (from: string, to: string, gap: number, over: Record<string, string> = {}) =>
    testAutomation(shower, { event: report(from, to, gap), state: baseState({ [H]: to, ...over }) });

  it('starts a shower on a step of at least the rise, shortly after the last report, well above baseline', () => {
    const r = detect('66', '73', 1);
    expect(r).toMatchObject({ decision: 'set_on', reason: 'shower_started' });
    expect(r.actions).toContainEqual(publish('ON'));
    expect(r.actions).toContainEqual({ type: 'timer.start', timerKey: MAX_ON, delayMs: 45 * MIN });
  });

  it('accepts a step exactly at the rise and a gap exactly at 10 minutes', () => {
    expect(detect('66', '71', 10).reason).toBe('shower_started');
  });

  it('ignores a step below the rise', () => {
    expect(detect('66', '70.9', 1)).toMatchObject({ decision: 'no_action', reason: 'no_shower', actions: [] });
  });

  it('ignores a big step after a long silence, since the sensor only reports on change', () => {
    expect(detect('62', '73', 19).reason).toBe('no_shower');
  });

  it('ignores a step that ends too close to baseline (a sink, not a shower)', () => {
    expect(detect('61.9', '68.3', 5.4, { [BASELINE]: '62' }).reason).toBe('no_shower');
  });

  it('accepts a step once it lands at least the above-baseline helper over baseline', () => {
    expect(detect('62', '68', 5, { [BASELINE]: '62' }).reason).toBe('no_shower');
    expect(detect('62', '68', 5, { [BASELINE]: '62', [ABOVE]: '4' }).reason).toBe('shower_started');
    expect(detect('62', '70', 5, { [BASELINE]: '62' }).reason).toBe('shower_started');
  });

  it('lowers the bar to rise-2 near saturation and ignores baseline there', () => {
    expect(detect('89.2', '92.9', 3.2, { [BASELINE]: '88' }).reason).toBe('shower_started');
    expect(detect('89.2', '91.9', 3, { [BASELINE]: '88' }).reason).toBe('no_shower');
  });

  it('never goes below a 2 point step near saturation, however low the rise is set', () => {
    expect(detect('90', '91.5', 1, { [RISE]: '3' }).reason).toBe('no_shower');
    expect(detect('90', '92', 1, { [RISE]: '3' }).reason).toBe('shower_started');
  });

  it('does not judge rises on timers or start-up, which have no step', () => {
    const state = baseState({ [H]: '90', [MAX]: '90' });
    expect(testAutomation(shower, { event: timer(MAX_ON), state }).reason).toBe('no_shower');
    expect(testAutomation(shower, { event: onStart, state }).reason).toBe('no_shower');
  });

  it('records the step, gap and height above baseline in the decision conditions', () => {
    expect(detect('66', '73', 2).conditions).toMatchObject({ step: 7, gapMins: 2, aboveBaseline: 13, requiredStep: 5 });
  });
});

describe('shower end', () => {
  const falling = { [SHOWER]: 'on', [H]: '88', [MAX]: '93' };
  const fall = (over: Record<string, string> = {}, from = '91', to = '88') =>
    testAutomation(shower, { event: report(from, to), state: baseState({ ...falling, ...over }) });

  it('starts the end-confirm timer when humidity first falls the drop below the peak', () => {
    const r = fall();
    expect(r).toMatchObject({ reason: 'shower_end_pending' });
    expect(r.actions).toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 5 * MIN }]);
  });

  it('does not restart the timer on later reports while the fall continues', () => {
    expect(fall({ [H]: '86' }, '88', '86')).toMatchObject({ reason: 'shower_end_pending', actions: [] });
  });

  it('does not treat a fall smaller than the drop as the end', () => {
    expect(fall({ [H]: '91' }, '93', '91')).toMatchObject({ reason: 'shower_running', actions: [] });
  });

  it('cancels the pending end when humidity climbs again (stepped out of the water, then back in)', () => {
    const r = fall({ [H]: '93', [MAX]: '93' }, '89', '93');
    expect(r).toMatchObject({ reason: 'shower_resumed' });
    expect(r.actions).toEqual([{ type: 'timer.cancel', timerKey: CONFIRM }]);
  });

  it('publishes OFF when end-confirm expires', () => {
    const r = testAutomation(shower, { event: timer(CONFIRM), state: baseState(falling) });
    expect(r).toMatchObject({ decision: 'set_off', reason: 'shower_ended' });
    expect(r.actions).toContainEqual(publish('OFF'));
    expect(r.actions).toContainEqual({ type: 'timer.cancel', timerKey: MAX_ON });
  });

  it('forces OFF at the 45 minute cap whatever the humidity says', () => {
    const r = testAutomation(shower, { event: timer(MAX_ON), state: baseState({ [SHOWER]: 'on', [H]: '95', [MAX]: '95' }) });
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
  const pending = (over: Record<string, string>) =>
    testAutomation(shower, { event: report('91', '88'), state: baseState({ [SHOWER]: 'on', [H]: '88', [MAX]: '93', ...over }) });

  it('clamps an over-long end-confirm helper to 10 minutes', () => {
    expect(pending({ 'input_number.bathroom_automation_shower_end_confirm': '90' }).actions)
      .toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 10 * MIN }]);
  });

  it('clamps an end-confirm helper below 2 minutes up to 2', () => {
    expect(pending({ 'input_number.bathroom_automation_shower_end_confirm': '0' }).actions)
      .toEqual([{ type: 'timer.start', timerKey: CONFIRM, delayMs: 2 * MIN }]);
  });

  it('clamps a rise of 0 up to 3 so a 2.9 point drift step cannot start a shower', () => {
    const r = testAutomation(shower, { event: report('66', '68.9'), state: baseState({ [H]: '68.9', [RISE]: '0', [ABOVE]: '4' }) });
    expect(r.reason).toBe('no_shower');
  });

  it('clamps a rise of 50 down to 8 so a real 8 point step is still found', () => {
    const r = testAutomation(shower, { event: report('66', '74'), state: baseState({ [H]: '74', [RISE]: '50' }) });
    expect(r.reason).toBe('shower_started');
  });

  it('clamps the above-baseline helper to 4-15', () => {
    const lowOk = testAutomation(shower, { event: report('60', '65'), state: baseState({ [H]: '65', [ABOVE]: '0', [BASELINE]: '62' }) });
    expect(lowOk.reason).toBe('no_shower'); // 3 above baseline < 4
    const highOk = testAutomation(shower, { event: report('70', '75'), state: baseState({ [H]: '75', [ABOVE]: '99', [BASELINE]: '60' }) });
    expect(highOk.reason).toBe('shower_started'); // 15 above baseline >= 15
  });

  it('clamps an end drop of 0 up to 1 so sensor noise is not a fall', () => {
    const state = baseState({ [SHOWER]: 'on', [H]: '92.5', [MAX]: '93', 'input_number.bathroom_automation_shower_end_drop': '0' });
    expect(testAutomation(shower, { event: report('93', '92.5'), state }).reason).toBe('shower_running');
  });
});

describe('bad inputs abort loudly', () => {
  const aborts = (over: Record<string, string>, event = report('66', '67')) =>
    testAbort(shower, { event, state: baseState(over) }).reason;

  it.each([
    ['humidity unavailable', { [H]: 'unavailable' }, `humidity_unavailable:${H}`],
    ['humidity above 100', { [H]: '140' }, `humidity_unavailable:${H}`],
    ['humidity negative', { [H]: '-4' }, `humidity_unavailable:${H}`],
    ['max_10m unknown', { [MAX]: 'unknown' }, `humidity_unavailable:${MAX}`],
    ['baseline unknown', { [BASELINE]: 'unknown' }, `humidity_unavailable:${BASELINE}`],
    ['baseline unavailable', { [BASELINE]: 'unavailable' }, `humidity_unavailable:${BASELINE}`],
    ['rise helper unavailable', { [RISE]: 'unavailable' }, `helper_unavailable:${RISE}`],
    ['above-baseline helper missing', { [ABOVE]: 'unknown' }, `helper_unavailable:${ABOVE}`],
    ['shower entity unavailable', { [SHOWER]: 'unavailable' }, 'shower_state_unavailable:unavailable'],
  ])('%s', (_name, over, reason) => {
    expect(aborts(over)).toBe(reason);
  });

  it('aborts when the previous report was unavailable, rather than guessing a step', () => {
    expect(aborts({}, report('unavailable', '67'))).toBe('humidity_previous_unavailable:unavailable');
  });

  it('aborts when a report has no usable timestamp, rather than assuming a gap', () => {
    expect(aborts({}, report('66', '67', 1, ['', 'nonsense']))).toBe('humidity_timestamp_invalid');
  });

  it('treats a never-published shower sensor (unknown) as off, the normal state before the first shower', () => {
    const r = testAutomation(shower, { event: report('66', '67'), state: baseState({ [SHOWER]: 'unknown' }) });
    expect(r.reason).toBe('no_shower');
  });
});

describe('statistics model (matches homeassistant statistics)', () => {
  it('keeps the last sample when it is the only one, however old', () => {
    expect(windowAt([[0, 60]], 5000, 600)).toEqual([60]);
  });
  it('purges samples strictly older than max_age after adding the new one', () => {
    expect(windowAt([[0, 60], [300, 64], [301, 66]], 301, 300)).toEqual([64, 66]);
  });
  it('computes the 10th percentile like python statistics.quantiles(method=exclusive)', () => {
    expect(percentileExclusive([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 10)).toBeCloseTo(1.1, 6);
    expect(percentileExclusive([42], 10)).toBe(42);
  });
});

// ---------- Replay of the recorded series ----------

const at = (local: string) => Date.parse(local) / 1000;
const published = (r: ReplayResult, payload: string) => r.published.filter((p) => p.payload === payload).map((p) => p.atS);

// Europe/London: BST (+01:00) until 02:00 on 25 Oct 2026, GMT after.
const SHOWERS: Array<[string, string]> = [
  ['22 Oct 17:16', '2026-10-22T17:16:00+01:00'],
  ['24 Oct 15:45', '2026-10-24T15:45:00+01:00'],
  ['25 Oct 18:03', '2026-10-25T18:03:00+00:00'],
  ['26 Oct 07:47', '2026-10-26T07:47:00+00:00'],
  ['26 Oct 18:34', '2026-10-26T18:34:00+00:00'],
  ['27 Oct 06:52', '2026-10-27T06:52:00+00:00'],
  ['28 Oct 07:25', '2026-10-28T07:25:00+00:00'],
  ['29 Oct 07:58', '2026-10-29T07:58:00+00:00'],
  ['30 Oct 08:44', '2026-10-30T08:44:00+00:00'],
  ['31 Oct 17:18', '2026-10-31T17:18:00+00:00'],
];
const SECOND_RISES: Array<[string, string]> = [
  ['24 Oct 16:01', '2026-10-24T16:01:00+01:00'],
  ['28 Oct 07:50', '2026-10-28T07:50:00+00:00'],
];
// Rises that must not start a shower: slow drift, the sink, and big steps after long silences.
const NOT_SHOWERS: Array<[string, string, string]> = [
  ['25 Oct 11:51 slow rise', '2026-10-25T11:45:00+00:00', '2026-10-25T12:55:00+00:00'],
  ['25 Oct 07:41 sink', '2026-10-25T07:35:00+00:00', '2026-10-25T07:55:00+00:00'],
  ['23 Oct 08:06 (19 min gap)', '2026-10-23T08:00:00+01:00', '2026-10-23T08:10:00+01:00'],
  ['27 Oct 19:37 (17 min gap)', '2026-10-27T19:30:00+00:00', '2026-10-27T19:40:00+00:00'],
  ['28 Oct 17:56 (28 min gap)', '2026-10-28T17:50:00+00:00', '2026-10-28T18:00:00+00:00'],
];

describe('replay of the recorded series (rise 5, above baseline 8, drop 3, confirm 5)', () => {
  const r = replay(HUMIDITY_SERIES);
  const ons = published(r, 'ON');
  const offs = published(r, 'OFF');

  it.each(SHOWERS)('detects the %s shower within 3 minutes of the recorded step', (_n, local) => {
    const t = at(local);
    expect(ons.some((o) => o >= t - 60 && o <= t + 180)).toBe(true);
  });

  it.each(SECOND_RISES)('starts a shower, or keeps one running, at the %s second rise', (_n, local) => {
    const t = at(local);
    const startedThen = ons.some((o) => o >= t - 60 && o <= t + 180);
    const keptRunning = ons.some((o) => o < t) && !offs.some((o) => o > ons.filter((x) => x < t).at(-1)! && o < t);
    expect(startedThen || keptRunning).toBe(true);
  });

  it.each(NOT_SHOWERS)('does not detect %s', (_n, from, to) => {
    expect(ons.filter((o) => o >= at(from) && o <= at(to))).toEqual([]);
  });

  it('starts exactly the showers and second rises expected, nothing else', () => {
    // 31 Oct 17:38 is a second rise 20 min after the first 17:18 shower ended.
    expect(ons).toHaveLength(SHOWERS.length + SECOND_RISES.length + 1);
  });

  it('ends every shower within 35 minutes of its start, never by the 45 minute cap', () => {
    expect(offs).toHaveLength(ons.length);
    ons.forEach((o, i) => expect(offs[i]! - o).toBeLessThanOrEqual(35 * 60));
    expect(r.published.some((p) => p.reason === 'shower_max_duration')).toBe(false);
    expect(r.published.at(-1)!.payload).toBe('OFF');
  });

  it('does not let the mid-shower dip end a shower before the confirm window has passed', () => {
    ons.forEach((o, i) => expect(offs[i]! - o).toBeGreaterThanOrEqual(5 * 60));
  });

  it('replays all 1191 recorded reports without any input aborting', () => {
    expect(r.reasons.length).toBeGreaterThan(1190);
  });
});

describe('replay sensitivity', () => {
  it('documents why the default rise is 5: at the loosest setting (3) the slow 25 Oct rise starts a shower', () => {
    const helpers = { ...HELPERS, [RISE]: { state: '3' } };
    const t = replay(HUMIDITY_SERIES, helpers);
    const slow = published(t, 'ON').filter((o) => o >= at('2026-10-25T11:45:00+00:00') && o <= at('2026-10-25T12:55:00+00:00'));
    // Steps there are 3.1 and 3.4 and the gap is short, so rise 3 would start a shower: documents why the default is 5.
    expect(slow.length).toBeGreaterThan(0);
  });
});
