// Is a TRV still accepting the room temperature fed to it? `heating/room-temp-feed.ts` writes the room
// sensor's temperature x 100 to `number.<room>_trv_external_measured_room_sensor`; the number updates
// within seconds when the TRV takes the write. A TRV that lost its outbound Zigbee route keeps
// reporting its old `heat_required` (zigbee2mqtt republishes cached state), so the number is the one
// signal that shows the writes are not landing.

/** Above the feed's 0.01 C rounding and ordinary sensor jitter, so a healthy room never trips it. */
export const MISMATCH_TOLERANCE_C = 0.3;
/** Far longer than a write takes to confirm, shorter than a night of wasted boiler time. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

const MIN_PLAUSIBLE_C = 0;
const MAX_PLAUSIBLE_C = 40;
const CENTI_PER_C = 100;

export type TrvStateReader = (entityId: string) => { state?: unknown; last_updated?: unknown } | undefined;

// Strict: Number('') is 0 and Number(null) is 0, which would read as a real temperature.
function parseNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function plausible(celsius: number | null): celsius is number {
  return celsius !== null && celsius >= MIN_PLAUSIBLE_C && celsius <= MAX_PLAUSIBLE_C;
}

export interface TrvConfirmationInput {
  /** State of the TRV's external-sensor number (room temperature x 100). */
  numberState: unknown;
  /** When that number last updated, as an ISO string. */
  numberUpdatedAt: unknown;
  /** State of the room's temperature sensor, in C. */
  roomTempState: unknown;
  /** Current time in ms; passed in so the check stays pure. */
  nowMs: number;
}

/**
 * True only when the TRV is provably not confirming the feed: the number disagrees with the room
 * sensor by more than the tolerance AND has not updated for longer than the stale threshold. A
 * steady room has no mismatch, and a changing room refreshes the number within seconds, so
 * neither is flagged. Anything missing, non-numeric, implausible or in the future is "cannot
 * judge" and returns false, so the caller keeps its existing behaviour for that room.
 */
export function isTrvUnconfirmed(input: TrvConfirmationInput): boolean {
  if (!Number.isFinite(input.nowMs)) throw new Error('isTrvUnconfirmed: nowMs is not finite');

  const numberC = parseNumber(input.numberState);
  const roomC = parseNumber(input.roomTempState);
  if (numberC === null || !plausible(numberC / CENTI_PER_C) || !plausible(roomC)) return false;

  if (typeof input.numberUpdatedAt !== 'string') return false;
  const updatedMs = Date.parse(input.numberUpdatedAt);
  if (!Number.isFinite(updatedMs)) return false;

  // Rounded to the feed's 0.01 C step so float noise cannot tip a mismatch of exactly the tolerance.
  const mismatchC = Math.round(Math.abs(numberC - roomC * CENTI_PER_C)) / CENTI_PER_C;
  const ageMs = input.nowMs - updatedMs;
  return mismatchC > MISMATCH_TOLERANCE_C && ageMs > STALE_AFTER_MS;
}

/** The rooms (in input order) whose TRV is unconfirmed; a room whose entities are absent is not. */
export function unconfirmedRooms(rooms: readonly string[], state: TrvStateReader, nowMs: number): string[] {
  return rooms.filter(room => {
    const number = state(`number.${room}_trv_external_measured_room_sensor`);
    const sensor = state(`sensor.${room}_sensor_climate_temperature`);
    return isTrvUnconfirmed({
      numberState: number?.state,
      numberUpdatedAt: number?.last_updated,
      roomTempState: sensor?.state,
      nowMs,
    });
  });
}
