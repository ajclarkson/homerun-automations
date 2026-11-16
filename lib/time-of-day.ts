const MINUTES_PER_DAY = 24 * 60;
const NOON = 12 * 60;

// Minutes elapsed since the most recent noon, so an evening window that crosses midnight
// is still one contiguous range (e.g. 22:00 → 600, 00:00 → 720, 01:30 → 810). Callers compare
// two of these to ask "is it before the end time?" without midnight wrapping the answer.
export function minutesSinceNoon(hour: number, minute: number): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`minutesSinceNoon: invalid hour ${hour}`);
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error(`minutesSinceNoon: invalid minute ${minute}`);
  return (hour * 60 + minute - NOON + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

/** Parses 'HH:MM' or 'HH:MM:SS' (an input_datetime time-only state) into minutes after midnight; null if it is neither. */
export function parseTimeOfDay(text: unknown): number | null {
  if (typeof text !== 'string') return null;
  const match = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(text);
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

/** Formats minutes after midnight as 'HH:MM'. */
export function formatTimeOfDay(minutes: number): string {
  if (!Number.isInteger(minutes) || minutes < 0 || minutes >= MINUTES_PER_DAY) throw new Error(`formatTimeOfDay: ${minutes} is not a minute of the day`);
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}
