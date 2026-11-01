import { testAutomation } from '@ajclarkson/homerun/testing';
import type { Action } from '@ajclarkson/homerun';
import shower from './shower.js';

// Test harness: replays recorded humidity through the shower automation with
// homeassistant's statistics windowing and homerun's timers simulated.

const H = 'sensor.bathroom_sensor_climate_humidity';
const MAX = 'sensor.bathroom_humidity_max_10m';
const BASELINE = 'sensor.bathroom_humidity_baseline';
const SHOWER = 'binary_sensor.bathroom_shower';

export const HELPERS = {
  'input_number.bathroom_automation_shower_rise': { state: '5' },
  'input_number.bathroom_automation_shower_above_baseline': { state: '8' },
  'input_number.bathroom_automation_shower_end_drop': { state: '3' },
  'input_number.bathroom_automation_shower_end_confirm': { state: '5' },
};

export type Samples = Array<[number, number]>;

/**
 * Mirrors homeassistant statistics: the new sample is appended, then samples
 * strictly older than max_age are purged, keeping only the newest when it is
 * the sole sample (keep_last_sample).
 */
export function windowAt(samples: Samples, nowS: number, maxAgeS: number): number[] {
  const inWindow = samples.filter(([t]) => t <= nowS && nowS - t <= maxAgeS).map(([, v]) => v);
  if (inWindow.length > 0) return inWindow;
  const latest = samples.filter(([t]) => t <= nowS).at(-1);
  return latest ? [latest[1]] : [];
}

/** python statistics.quantiles(data, n=100, method='exclusive')[k-1]; a lone sample is returned as is. */
export function percentileExclusive(values: number[], k: number): number {
  if (values.length === 1) return values[0]!;
  const data = [...values].sort((a, b) => a - b);
  const m = data.length + 1;
  const j = Math.min(Math.max(Math.floor((k * m) / 100), 1), data.length - 1);
  const delta = k * m - j * 100;
  return (data[j - 1]! * (100 - delta) + data[j]! * delta) / 100;
}

export function statsAt(samples: Samples, nowS: number) {
  return {
    max: Math.max(...windowAt(samples, nowS, 600)),
    baseline: percentileExclusive(windowAt(samples, nowS, 3 * 3600), 10),
  };
}

export interface ReplayResult {
  published: Array<{ atS: number; payload: string; reason: string }>;
  reasons: Array<{ atS: number; reason: string }>;
}

type SimState = Record<string, { state: string }>;
const iso = (s: number) => new Date(s * 1000).toISOString();

/** Replays `all` samples, but only keeps `[fromS, toS]` as the observed range (the rest warms the 3 h baseline). */
export function replay(all: Samples, helpers: Record<string, { state: string }> = HELPERS): ReplayResult {
  const state: SimState = { ...helpers, [SHOWER]: { state: 'off' } };
  const timers = new Map<string, number>();
  const out: ReplayResult = { published: [], reasons: [] };

  const apply = (a: Action, atS: number, reason: string) => {
    if (a.type === 'mqtt.publish') {
      state[SHOWER] = { state: a.payload === 'ON' ? 'on' : 'off' };
      out.published.push({ atS, payload: a.payload, reason });
    } else if (a.type === 'timer.start') timers.set(a.timerKey, atS + a.delayMs / 1000);
    else if (a.type === 'timer.cancel') timers.delete(a.timerKey);
  };
  const fire = (atS: number, event: Record<string, unknown>) => {
    const result = testAutomation(shower, { event: event as never, state });
    const reason = result.reason ?? 'missing_reason';
    out.reasons.push({ atS, reason });
    for (const a of result.actions as Action[]) apply(a, atS, reason);
  };
  const setStats = (atS: number) => {
    const s = statsAt(all, atS);
    state[MAX] = { state: String(s.max) };
    state[BASELINE] = { state: String(s.baseline) };
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

  let prev: [number, number] | undefined;
  for (const [t, v] of all) {
    drainTimers(t);
    if (prev === undefined) {
      state[H] = { state: String(v) };
      setStats(t);
    } else {
      // Worst case ordering: the humidity event arrives before the statistics sensors update.
      state[H] = { state: String(v) };
      fire(t, {
        type: 'state_changed', entity_id: H, correlation_id: 'c',
        old_state: { entity_id: H, state: String(prev[1]), attributes: {}, last_changed: iso(prev[0]), last_updated: iso(prev[0]) },
        new_state: { entity_id: H, state: String(v), attributes: {}, last_changed: iso(t), last_updated: iso(t) },
      });
      setStats(t);
    }
    prev = [t, v];
  }
  drainTimers(all.at(-1)![0] + 3600);
  return out;
}
