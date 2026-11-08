import type { HAState } from '@ajclarkson/homerun';

// Lives under lib/ because homerun loads every other .ts file as an automation (it needs a
// default export); lib/ and types/ are excluded from that scan.

// Shared by shower.ts and fan.ts so both read the same entities with the same
// validation, and the hard caps live in one place.

export const SHOWER_TOPIC = 'bathroom/shower/state';
export const SHOWER_ENTITY = 'binary_sensor.bathroom_shower';
export const HUMIDITY_ENTITY = 'sensor.bathroom_sensor_climate_humidity';

export const SHOWER_MAX_ON_TIMER = 'bathroom:shower:max_on';
export const SHOWER_END_CONFIRM_TIMER = 'bathroom:shower:end_confirm';
export const FAN_MIN_RUN_TIMER = 'bathroom:fan:min_run';
export const FAN_MAX_RUN_TIMER = 'bathroom:fan:max_run';

const MS_PER_MIN = 60_000;

// Hard caps, the specification of what the automation considers valid. The HA
// helpers are tunable, but never outside these.
export const MAX_SHOWER_ON_MS = 45 * MS_PER_MIN;
// The step rule (see shower.ts) needs at least 3 points between two reports or
// ordinary drift (steps up to 3.4 recorded) would start showers; above 8 the
// smaller real first steps (6.2) would be missed.
export const MIN_RISE = 3;
export const MAX_RISE = 8;
// Height above the 3 h baseline required for a step to count. Below 4 the sink
// (about 6 above baseline) is borderline noise; above 15 a shower in a damp room is missed.
export const MIN_ABOVE_BASELINE = 4;
export const MAX_ABOVE_BASELINE = 15;
// At or above this level the room is nearly saturated (the sensor tops out near 95),
// so a real shower can only add a few points and sits far above baseline anyway.
export const SATURATED_LEVEL = 85;
// The smallest step accepted when saturated.
export const MIN_SATURATED_STEP = 2;
// A step only means "rising fast" if the two reports are close in time. The sensor reports
// on change, so a long gap hides how slowly the rise happened (recorded: 17, 19 and 28 min gaps
// that would otherwise look like showers).
export const MAX_STEP_GAP_MINS = 10;
// Below 1 point is sensor noise; above 10 the end would be missed entirely.
export const MIN_END_DROP = 1;
export const MAX_END_DROP = 10;
export const MIN_END_CONFIRM_MIN = 2;
export const MAX_END_CONFIRM_MIN = 10;
export const MIN_FAN_MIN_RUN_MIN = 5;
export const MAX_FAN_MIN_RUN_MIN = 30;
export const MIN_FAN_MAX_RUN_MIN = 15;
export const MAX_FAN_MAX_RUN_MIN = 120;
// A margin below 2 can never be reached (baseline is a low percentile); above
// 30 the fan would stop while the room is still wet.
export const MIN_FAN_MARGIN = 2;
export const MAX_FAN_MARGIN = 30;

/** Parses a numeric HA state; null when missing, unavailable, unknown or non-finite. */
export function readFinite(state: HAState, entity: string): number | null {
  const raw = state(entity as keyof HAEntities)?.state;
  if (raw === undefined || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export type ShowerReading = { kind: 'on' | 'off' } | { kind: 'unavailable'; raw: string };

/**
 * `unknown` means the retained topic has never been published, which is the
 * normal state before the first shower, so it reads as off. A missing or
 * `unavailable` entity is a broken setup and must abort.
 */
export function readShower(state: HAState): ShowerReading {
  const raw = state(SHOWER_ENTITY)?.state;
  if (raw === 'on') return { kind: 'on' };
  if (raw === 'off' || raw === 'unknown') return { kind: 'off' };
  return { kind: 'unavailable', raw: raw ?? 'missing' };
}

export const minutesToMs = (minutes: number): number => minutes * MS_PER_MIN;
