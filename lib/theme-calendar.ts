import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

// ── Calendar rules ──────────────────────────────────────────────────────────────

type MonthDay = `${number}-${number}`; // 'MM-DD'
type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

export type CalendarEntry =
  /** Inclusive yearly range; may wrap the new year (e.g. '12-20' → '01-05'). */
  | { theme: string; from: MonthDay; to: MonthDay }
  /** A single fixed day every year. */
  | { theme: string; on: MonthDay }
  /** The nth weekday of a month every year, e.g. Thanksgiving = 4th Thursday of November. */
  | { theme: string; nth: { n: 1 | 2 | 3 | 4 | 5; weekday: Weekday; month: number } };

const WEEKDAYS: Weekday[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function parseMonthDay(md: string): { month: number; day: number } {
  const match = /^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.exec(md);
  if (!match) throw new Error(`invalid calendar date '${md}' — expected 'MM-DD'`);
  return { month: Number(match[1]), day: Number(match[2]) };
}

// Day-of-year in a fixed leap year, so 'MM-DD' compares the same every year (Feb 29 included).
const ordinal = (month: number, day: number) =>
  Math.round((Date.UTC(2000, month - 1, day) - Date.UTC(2000, 0, 1)) / 86_400_000);
const DAYS_IN_YEAR = 366;

/** How many days an entry covers — shorter (more specific) entries win when entries overlap. */
function spanDays(entry: CalendarEntry): number {
  if (!('from' in entry)) return 1;
  const from = parseMonthDay(entry.from);
  const to = parseMonthDay(entry.to);
  return ((ordinal(to.month, to.day) - ordinal(from.month, from.day) + DAYS_IN_YEAR) % DAYS_IN_YEAR) + 1;
}

function matches(entry: CalendarEntry, date: Date): boolean {
  const month = date.getMonth() + 1;
  const day = date.getDate();
  if ('on' in entry) {
    const on = parseMonthDay(entry.on);
    return on.month === month && on.day === day;
  }
  if ('nth' in entry) {
    const { n, weekday, month: nthMonth } = entry.nth;
    return month === nthMonth && WEEKDAYS[date.getDay()] === weekday && Math.ceil(day / 7) === n;
  }
  const today = ordinal(month, day);
  const from = parseMonthDay(entry.from);
  const offset = (today - ordinal(from.month, from.day) + DAYS_IN_YEAR) % DAYS_IN_YEAR;
  return offset < spanDays(entry);
}

/** Validates every entry up front so a typo fails at load, not silently on the day. */
export function validateCalendar(calendar: CalendarEntry[]): void {
  for (const entry of calendar) {
    if ('on' in entry) parseMonthDay(entry.on);
    else if ('from' in entry) { parseMonthDay(entry.from); parseMonthDay(entry.to); }
    else if (!(entry.nth.month >= 1 && entry.nth.month <= 12)) throw new Error(`invalid calendar month ${entry.nth.month}`);
  }
}

/**
 * The theme the calendar picks for a local date. When entries overlap the shortest one wins
 * (Bonfire Night inside Autumn); on a tie the later entry wins. No match → fallback.
 */
export function themeFor(date: Date, calendar: CalendarEntry[], fallback: string): string {
  let best: { theme: string; span: number } | null = null;
  for (const entry of calendar) {
    if (!matches(entry, date)) continue;
    const span = spanDays(entry);
    if (!best || span <= best.span) best = { theme: entry.theme, span };
  }
  return best?.theme ?? fallback;
}

// ── Automation ──────────────────────────────────────────────────────────────────

export interface ThemeCalendarConfig {
  location: string;
  calendar: CalendarEntry[];
  /** Theme for days no entry covers. */
  fallback?: string;
}

// Runs just after midnight, when outdoor lights are already off, so a switch never visibly jumps.
export const CALENDAR_CRON = '5 0 * * *';

interface ThemeCalendarContext {
  trigger: 'daily' | 'system';
  calendarEnabled: boolean;
  currentTheme: string;
  todayTheme: string;
  yesterdayTheme: string;
  /** The calendar's answer changes today — the only days it switches, so manual picks stick until then. */
  boundaryDay: boolean;
  /** Theme still matches yesterday's calendar theme, i.e. today's switch hasn't happened and nobody overrode it. */
  stillOnYesterdaysTheme: boolean;
  targetIsOption: boolean;
}

export function makeThemeCalendarAutomation(config: ThemeCalendarConfig) {
  const { location, calendar, fallback = 'normal' } = config;
  validateCalendar(calendar);
  const themeEntity = `input_select.${location}_light_theme`;
  const enabledEntity = `input_boolean.${location}_light_theme_calendar_enabled`;

  return defineAutomation<ThemeCalendarContext>({
    id: `${location}:theme_calendar`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'schedule', cron: CALENDAR_CRON },
      { type: 'on_start' },
    ],

    context: (state, _ha, event) => {
      const enabled = state(enabledEntity as keyof HAEntities)?.state;
      if (enabled !== 'on' && enabled !== 'off') return abort(`calendar_toggle_unavailable:${location}`);

      const theme = state(themeEntity as keyof HAEntities);
      if (!theme || theme.state === 'unavailable' || theme.state === 'unknown') return abort(`theme_select_unavailable:${location}`);
      const options = Array.isArray(theme.attributes?.options) ? (theme.attributes.options as string[]) : [];

      const today = new Date();
      const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
      const todayTheme = themeFor(today, calendar, fallback);
      const yesterdayTheme = themeFor(yesterday, calendar, fallback);

      return {
        trigger: event.type === 'schedule' ? 'daily' : 'system',
        calendarEnabled: enabled === 'on',
        currentTheme: theme.state,
        todayTheme,
        yesterdayTheme,
        boundaryDay: todayTheme !== yesterdayTheme,
        stillOnYesterdaysTheme: theme.state === yesterdayTheme,
        targetIsOption: options.includes(todayTheme),
      };
    },

    reduce: (ctx) => {
      const { trigger, calendarEnabled, currentTheme, todayTheme, boundaryDay, stillOnYesterdaysTheme, targetIsOption } = ctx;

      if (!calendarEnabled) {
        return { decision: 'no_action', reason: 'calendar_disabled', actions: [] };
      }
      if (!boundaryDay) {
        // Mid-period: leave whatever is selected, including a manual pick.
        return { decision: 'no_action', reason: 'not_a_calendar_boundary', actions: [] };
      }
      if (currentTheme === todayTheme) {
        return { decision: 'no_action', reason: 'already_on_todays_theme', actions: [] };
      }
      // After a restart we can't tell a missed midnight switch from a manual pick made today —
      // only catch up if the theme is still exactly what the calendar had yesterday.
      if (trigger === 'system' && !stillOnYesterdaysTheme) {
        return { decision: 'no_action', reason: 'theme_changed_by_hand_today', actions: [] };
      }
      if (!targetIsOption) {
        return { decision: 'no_action', reason: `calendar_theme_not_an_option:${todayTheme}`, actions: [] };
      }
      return {
        decision: 'switch_theme',
        reason: trigger === 'system' ? 'calendar_boundary_catch_up' : 'calendar_boundary',
        actions: [HomeAssistant.input_select.select_option({ entity_id: themeEntity }, { option: todayTheme })],
      };
    },
  });
}
