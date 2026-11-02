import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
import fan from './fan.js';

const FAN = 'switch.bathroom_fan_extractor';
const SHOWER = 'binary_sensor.bathroom_shower';
const AUTO = 'binary_sensor.bathroom_fan_auto';
const ENABLED = 'input_boolean.bathroom_automation_fan_enabled';
const H = 'sensor.bathroom_sensor_climate_humidity';
const BASELINE = 'sensor.bathroom_humidity_baseline';
const MIN_RUN = 'bathroom:fan:min_run';
const MAX_RUN = 'bathroom:fan:max_run';
const MIN = 60_000;
const NOW = Date.parse('2026-10-30T09:00:00Z');

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

const ago = (mins: number) => new Date(NOW - mins * MIN).toISOString();
const stateChanged = (entity: string, to: string) => ({
  type: 'state_changed' as const, entity_id: entity,
  old_state: { entity_id: entity, state: 'x', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'c',
});
const timer = (timerKey: string) => ({ type: 'timer_expired' as const, timerKey, correlation_id: 'c' });
const onStart = { type: 'on_start' as const, correlation_id: 'c' };

interface World { fan?: string; auto?: string; shower?: string; showerChangedMinsAgo?: number; enabled?: string; humidity?: string; baseline?: string; extra?: Record<string, string> }
function world(w: World = {}) {
  const v: Record<string, string> = {
    [FAN]: w.fan ?? 'off', [AUTO]: w.auto ?? 'off', [SHOWER]: w.shower ?? 'off',
    [ENABLED]: w.enabled ?? 'on', [H]: w.humidity ?? '70', [BASELINE]: w.baseline ?? '60',
    'input_number.bathroom_automation_fan_humidity_margin': '10',
    'input_number.bathroom_automation_fan_min_run': '15',
    'input_number.bathroom_automation_fan_max_run': '60',
    ...w.extra,
  };
  const out: Record<string, { state: string; last_changed?: string }> = Object.fromEntries(Object.entries(v).map(([k, s]) => [k, { state: s }]));
  out[SHOWER] = { state: v[SHOWER]!, last_changed: ago(w.showerChangedMinsAgo ?? 0) };
  return out;
}

const turnOn = { type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: FAN } };
const turnOff = { type: 'ha.call_service', domain: 'switch', service: 'turn_off', target: { entity_id: FAN } };
const auto = (payload: 'ON' | 'OFF') => ({ type: 'mqtt.publish', topic: 'bathroom/fan/auto', payload, retain: true, impliesEntity: AUTO });
const cancel = (timerKey: string) => ({ type: 'timer.cancel', timerKey });
const start = (timerKey: string, mins: number) => ({ type: 'timer.start', timerKey, delayMs: mins * MIN });

describe('fan starts with the shower', () => {
  it('turns the fan on and claims ownership when a shower starts', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'on'), state: world({ shower: 'on' }) });
    expect(r).toMatchObject({ decision: 'turn_on', reason: 'fan_on_shower_started', outcome: 'acted' });
    expect(r.actions).toContainEqual(turnOn);
    expect(r.actions).toContainEqual(auto('ON'));
  });

  it('does not restart a fan that was switched off mid-shower on every humidity report', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '90'), state: world({ shower: 'on' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'fan_idle', outcome: 'ignored', actions: [] });
  });

  it('stays idle when there is no shower', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '70'), state: world() });
    expect(r).toMatchObject({ reason: 'fan_idle', outcome: 'ignored', actions: [] });
  });

  it('forgets ownership if the owner switched the fan off by hand', () => {
    const r = testAutomation(fan, { event: stateChanged(FAN, 'off'), state: world({ auto: 'on' }) });
    expect(r.reason).toBe('fan_idle');
    expect(r.outcome).toBe('ignored');
    expect(r.actions).toContainEqual(auto('OFF'));
  });
});

describe('fan stops after the shower', () => {
  const afterShower = (over: World) => world({ fan: 'on', auto: 'on', shower: 'off', ...over });

  it('arms min run and max run from the moment the shower ends', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'off'), state: afterShower({ showerChangedMinsAgo: 0 }) });
    expect(r.reason).toBe('fan_holding_min_run');
    expect(r.outcome).toBe('ignored');
    expect(r.actions).toEqual([start(MIN_RUN, 15), start(MAX_RUN, 60)]);
  });

  it('holds during the minimum run even when the room is already dry', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '62'), state: afterShower({ showerChangedMinsAgo: 5, humidity: '62' }) });
    expect(r).toMatchObject({ reason: 'fan_holding_min_run', outcome: 'ignored', actions: [] });
  });

  it('holds after the minimum run while humidity is above baseline plus margin', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '75'), state: afterShower({ showerChangedMinsAgo: 20, humidity: '75' }) });
    expect(r).toMatchObject({ reason: 'fan_holding_humidity_high', outcome: 'ignored', actions: [] });
  });

  it('turns off once the minimum run has passed and humidity is within the margin', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '69'), state: afterShower({ showerChangedMinsAgo: 20, humidity: '69' }) });
    expect(r).toMatchObject({ decision: 'turn_off', reason: 'fan_off_humidity_normal', outcome: 'acted' });
    expect(r.actions).toContainEqual(turnOff);
    expect(r.actions).toContainEqual(auto('OFF'));
    expect(r.actions).toContainEqual(cancel(MAX_RUN));
  });

  it('treats humidity exactly at baseline plus margin as normal', () => {
    const r = testAutomation(fan, { event: timer(MIN_RUN), state: afterShower({ showerChangedMinsAgo: 15, humidity: '70' }) });
    expect(r.reason).toBe('fan_off_humidity_normal');
    expect(r.outcome).toBe('acted');
  });

  it('re-checks when the min-run timer expires, since humidity may not report again for a while', () => {
    const r = testAutomation(fan, { event: timer(MIN_RUN), state: afterShower({ showerChangedMinsAgo: 15.1, humidity: '65' }) });
    expect(r).toMatchObject({ decision: 'turn_off', reason: 'fan_off_humidity_normal', outcome: 'acted' });
  });

  it('turns off at max run even when the room is still humid', () => {
    const r = testAutomation(fan, { event: timer(MAX_RUN), state: afterShower({ showerChangedMinsAgo: 60, humidity: '90' }) });
    expect(r).toMatchObject({ decision: 'turn_off', reason: 'fan_off_max_run', outcome: 'acted' });
    expect(r.actions).toContainEqual(auto('OFF'));
  });
});

describe('another shower while the fan runs', () => {
  it('cancels both timers so the full run is timed from the last shower', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'on'), state: world({ fan: 'on', auto: 'on', shower: 'on' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'fan_run_extended', outcome: 'ignored' });
    expect(r.actions).toEqual([cancel(MIN_RUN), cancel(MAX_RUN)]);
  });

  it('does not turn the fan off while the shower is running', () => {
    const r = testAutomation(fan, { event: timer(MIN_RUN), state: world({ fan: 'on', auto: 'on', shower: 'on', humidity: '61', showerChangedMinsAgo: 40 }) });
    expect(r.actions).toEqual([]);
  });
});

describe('a fan the controller did not start', () => {
  it('is left running by humidity, timers and shower end', () => {
    for (const event of [stateChanged(H, '60'), timer(MAX_RUN), timer(MIN_RUN), stateChanged(SHOWER, 'off')]) {
      const r = testAutomation(fan, { event, state: world({ fan: 'on', auto: 'off', humidity: '60', showerChangedMinsAgo: 90 }) });
      expect(r).toMatchObject({ decision: 'no_action', reason: 'fan_not_auto_started_idle', outcome: 'ignored', actions: [] });
    }
  });

  it('is left alone when a shower starts while the owner already has it on', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'on'), state: world({ fan: 'on', auto: 'off', shower: 'on' }) });
    expect(r).toMatchObject({ reason: 'fan_not_auto_started', outcome: 'declined', actions: [] });
  });

  it('is treated as manual when the auto flag has never been published', () => {
    const r = testAutomation(fan, { event: stateChanged(H, '60'), state: world({ fan: 'on', auto: 'unknown' }) });
    expect(r.reason).toBe('fan_not_auto_started_idle');
    expect(r.outcome).toBe('ignored');
  });
});

describe('disabled', () => {
  it('declines and touches nothing, even when a shower has just started', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'on'), state: world({ enabled: 'off', shower: 'on' }) });
    expect(r).toMatchObject({ decision: 'no_action', reason: 'automation_disabled', outcome: 'declined', actions: [] });
  });

  it('declines when it would otherwise turn off an owned fan', () => {
    const r = testAutomation(fan, { event: timer(MAX_RUN), state: world({ enabled: 'off', fan: 'on', auto: 'on' }) });
    expect(r).toMatchObject({ reason: 'automation_disabled_idle', outcome: 'ignored', actions: [] });
  });
});

describe('restart recovery', () => {
  it('re-arms both timers for an owned running fan, so it cannot run forever', () => {
    const r = testAutomation(fan, { event: onStart, state: world({ fan: 'on', auto: 'on', showerChangedMinsAgo: 3 }) });
    expect(r.actions).toEqual([start(MIN_RUN, 15), start(MAX_RUN, 60)]);
  });

  it('turns the fan on if a shower is already running at start-up', () => {
    const r = testAutomation(fan, { event: onStart, state: world({ shower: 'on' }) });
    expect(r.reason).toBe('fan_on_shower_started');
    expect(r.outcome).toBe('acted');
  });
});

describe('inputs and clamps', () => {
  const abortReason = (w: World) => testAbort(fan, { event: stateChanged(H, '70'), state: world(w) }).reason;

  it.each([
    ['fan unavailable', { fan: 'unavailable' }, 'fan_unavailable:unavailable'],
    ['fan unknown', { fan: 'unknown' }, 'fan_unavailable:unknown'],
    ['enable helper unavailable', { enabled: 'unavailable' }, 'enabled_unavailable:unavailable'],
    ['humidity unavailable', { humidity: 'unavailable' }, `humidity_unavailable:${H}`],
    ['baseline unknown', { baseline: 'unknown' }, `humidity_unavailable:${BASELINE}`],
    ['margin helper unavailable', { extra: { 'input_number.bathroom_automation_fan_humidity_margin': 'unavailable' } }, 'helper_unavailable:input_number.bathroom_automation_fan_humidity_margin'],
    ['auto flag unavailable', { auto: 'unavailable' }, 'fan_auto_flag_unavailable:unavailable'],
    ['shower entity unavailable', { shower: 'unavailable' }, 'shower_state_unavailable:unavailable'],
  ] as const)('aborts: %s', (_n, w, reason) => {
    expect(abortReason(w as World)).toBe(reason);
  });

  it('aborts rather than declining when the fan is unavailable and automation is disabled', () => {
    expect(abortReason({ fan: 'unavailable', enabled: 'off' })).toBe('fan_unavailable:unavailable');
  });

  it('clamps min run to 5-30 and max run to 15-120 minutes', () => {
    const low = testAutomation(fan, { event: stateChanged(SHOWER, 'off'), state: world({ fan: 'on', auto: 'on', extra: { 'input_number.bathroom_automation_fan_min_run': '0', 'input_number.bathroom_automation_fan_max_run': '1' } }) });
    expect(low.actions).toEqual([start(MIN_RUN, 5), start(MAX_RUN, 15)]);
    const high = testAutomation(fan, { event: stateChanged(SHOWER, 'off'), state: world({ fan: 'on', auto: 'on', extra: { 'input_number.bathroom_automation_fan_min_run': '999', 'input_number.bathroom_automation_fan_max_run': '9999' } }) });
    expect(high.actions).toEqual([start(MIN_RUN, 30), start(MAX_RUN, 120)]);
  });

  it('clamps the humidity margin to 2-30 points', () => {
    const state = world({ fan: 'on', auto: 'on', showerChangedMinsAgo: 20, humidity: '65', extra: { 'input_number.bathroom_automation_fan_humidity_margin': '0' } });
    expect(testAutomation(fan, { event: stateChanged(H, '65'), state }).reason).toBe('fan_holding_humidity_high');
  });

  it('never lets the cap be shorter than the minimum run', () => {
    const r = testAutomation(fan, { event: stateChanged(SHOWER, 'off'), state: world({ fan: 'on', auto: 'on', extra: { 'input_number.bathroom_automation_fan_min_run': '30', 'input_number.bathroom_automation_fan_max_run': '15' } }) });
    expect(r.actions).toEqual([start(MIN_RUN, 30), start(MAX_RUN, 30)]);
  });

  it('is not driven by occupancy or lights', () => {
    const r = testAutomation(fan, { event: stateChanged('binary_sensor.bathroom_occupied', 'off'), state: world({ fan: 'on', auto: 'on', showerChangedMinsAgo: 5 }) });
    expect(r.reason).toBe('fan_holding_min_run');
    expect(r.outcome).toBe('ignored');
    expect(JSON.stringify(fan.triggers)).not.toMatch(/occupied|light/);
  });
});
