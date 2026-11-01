import type { HAState } from '@ajclarkson/homerun';

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
// Quiet drift peaks at 1.3 points / 5 min and every recorded shower rises at
// least 4.3, so below 2 would false-start and above 6 would miss second showers.
export const MIN_RISE = 2;
export const MAX_RISE = 6;
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

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max);

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
