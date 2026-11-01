import { testAutomation } from '@ajclarkson/homerun/testing';
import type { Action } from '@ajclarkson/homerun';
import shower from './shower.js';
import type { HumidityWindow } from './fixtures/humidity-windows.js';

// Test harness: replays a recorded humidity window through the shower
// automation, with HA's statistics-sensor windowing and homerun's timers
// simulated, and returns what the automation did.

const H = 'sensor.bathroom_sensor_climate_humidity';
const CHANGE = 'sensor.bathroom_humidity_change_5m';
const MAX = 'sensor.bathroom_humidity_max_10m';

export const HELPERS = {
  'input_number.bathroom_automation_shower_rise': { state: '4' },
  'input_number.bathroom_automation_shower_end_drop': { state: '3' },
  'input_number.bathroom_automation_shower_end_confirm': { state: '5' },
};

type Samples = Array<[number, number]>;

/**
 * Mirrors homeassistant statistics: the new sample is appended, then samples
 * strictly older than max_age are purged, keeping only the newest when it is
 * the sole sample (keep_last_sample). A one-sample window has change 0.
 */
export function windowAt(samples: Samples, nowS: number, maxAgeS: number): number[] {
  const inWindow = samples.filter(([t]) => t <= nowS && nowS - t <= maxAgeS).map(([, v]) => v);
  if (inWindow.length > 0) return inWindow;
  const latest = samples.filter(([t]) => t <= nowS).at(-1);
  return latest ? [latest[1]] : [];
}

export function statsAt(samples: Samples, nowS: number) {
  const w5 = windowAt(samples, nowS, 300);
  const w10 = windowAt(samples, nowS, 600);
  return { change: w5.at(-1)! - w5[0]!, max: Math.max(...w10) };
}

export interface ReplayResult {
  /** Seconds from window start of each publish. */
  published: Array<{ atS: number; payload: string; reason: string }>;
  reasons: Array<{ atS: number; reason: string }>;
}

type SimState = Record<string, { state: string }>;

export function replay(window: HumidityWindow, helpers: Record<string, { state: string }> = HELPERS): ReplayResult {
  const samples = window.samples;
  const state: SimState = { ...helpers, 'binary_sensor.bathroom_shower': { state: 'off' } };
  const timers = new Map<string, number>();
  const out: ReplayResult = { published: [], reasons: [] };
  let prevHumidity: number | undefined;

  const fire = (atS: number, event: Record<string, unknown>) => {
    const result = testAutomation(shower, { event: event as never, state });
    const reason = result.reason ?? 'missing_reason';
    out.reasons.push({ atS, reason });
    for (const a of result.actions as Action[]) apply(a, atS, reason);
  };
  const apply = (a: Action, atS: number, reason: string) => {
    if (a.type === 'mqtt.publish') {
      state['binary_sensor.bathroom_shower'] = { state: a.payload === 'ON' ? 'on' : 'off' };
      out.published.push({ atS, payload: a.payload, reason });
    } else if (a.type === 'timer.start') timers.set(a.timerKey, atS + a.delayMs / 1000);
    else if (a.type === 'timer.cancel') timers.delete(a.timerKey);
  };
  const stateChanged = (entity: string, from: string | undefined, to: string) => ({
    type: 'state_changed', entity_id: entity,
    old_state: from === undefined ? undefined : { state: from }, new_state: { state: to }, correlation_id: 'c',
  });
  const setStats = (atS: number) => {
    const s = statsAt(samples, atS);
    state[CHANGE] = { state: String(s.change) };
    state[MAX] = { state: String(s.max) };
  };
  const drainTimers = (untilS: number) => {
    for (;;) {
      const next = [...timers.entries()].filter(([, due]) => due <= untilS).sort((a, b) => a[1] - b[1])[0];
      if (!next) return;
      timers.delete(next[0]);
      setStats(next[1]);
      fire(next[1], { type: 'timer_expired', timerKey: next[0], correlation_id: 'c' });
    }
  };

  for (const [t, v] of samples) {
    drainTimers(t);
    if (prevHumidity === undefined) {
      state[H] = { state: String(v) };
      setStats(t);
    } else {
      // Worst case ordering: the humidity event arrives before the statistics sensors update.
      state[H] = { state: String(v) };
      fire(t, stateChanged(H, String(prevHumidity), String(v)));
      setStats(t);
      fire(t, stateChanged(MAX, undefined, String(state[MAX]?.state)));
      fire(t, stateChanged(CHANGE, undefined, String(state[CHANGE]?.state)));
    }
    prevHumidity = v;
  }
  drainTimers(samples.at(-1)![0] + 3600);
  return out;
}

