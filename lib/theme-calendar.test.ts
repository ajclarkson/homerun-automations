import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import { themeFor, validateCalendar, makeThemeCalendarAutomation, CALENDAR_CRON, type CalendarEntry } from './theme-calendar.js';

const day = (y: number, m: number, d: number) => new Date(y, m - 1, d, 12, 0);

const CALENDAR: CalendarEntry[] = [
  { theme: 'autumn', from: '09-01', to: '11-30' },
  { theme: 'halloween', from: '10-20', to: '10-31' },
  { theme: 'bonfire', on: '11-05' },
  { theme: 'thanksgiving', nth: { n: 4, weekday: 'thu', month: 11 } },
  { theme: 'christmas', from: '12-01', to: '12-31' },
];
const pick = (y: number, m: number, d: number) => themeFor(day(y, m, d), CALENDAR, 'normal');

describe('theme calendar rules', () => {
  describe('date ranges', () => {
    it('covers every day from start to end inclusive', () => {
      expect(pick(2026, 9, 1)).toBe('autumn');
      expect(pick(2026, 10, 1)).toBe('autumn');
      expect(pick(2026, 11, 30)).toBe('autumn');
    });

    it('falls back outside every range', () => {
      expect(pick(2026, 8, 31)).toBe('normal');
      expect(pick(2027, 1, 15)).toBe('normal');
      expect(pick(2027, 6, 21)).toBe('normal');
    });

    it('handles a range that wraps the new year', () => {
      const festive: CalendarEntry[] = [{ theme: 'festive', from: '12-20', to: '01-05' }];
      expect(themeFor(day(2026, 12, 19), festive, 'normal')).toBe('normal');
      expect(themeFor(day(2026, 12, 20), festive, 'normal')).toBe('festive');
      expect(themeFor(day(2027, 1, 1), festive, 'normal')).toBe('festive');
      expect(themeFor(day(2027, 1, 5), festive, 'normal')).toBe('festive');
      expect(themeFor(day(2027, 1, 6), festive, 'normal')).toBe('normal');
    });

    it('treats leap day like any other day in a range', () => {
      const late: CalendarEntry[] = [{ theme: 'late_winter', from: '02-20', to: '03-05' }];
      expect(themeFor(day(2028, 2, 29), late, 'normal')).toBe('late_winter');
      expect(themeFor(day(2027, 3, 5), late, 'normal')).toBe('late_winter');
    });
  });

  describe('overlapping entries', () => {
    it('lets Halloween win inside Autumn because it is the shorter period', () => {
      expect(pick(2026, 10, 19)).toBe('autumn');
      expect(pick(2026, 10, 20)).toBe('halloween');
      expect(pick(2026, 10, 31)).toBe('halloween');
      expect(pick(2026, 11, 1)).toBe('autumn');
    });

    it('lets single days win over the range around them', () => {
      expect(pick(2026, 11, 4)).toBe('autumn');
      expect(pick(2026, 11, 5)).toBe('bonfire');
      expect(pick(2026, 11, 6)).toBe('autumn');
    });

    it('resolves a tie in favour of the entry listed later', () => {
      const tie: CalendarEntry[] = [{ theme: 'first', on: '06-01' }, { theme: 'second', on: '06-01' }];
      expect(themeFor(day(2027, 6, 1), tie, 'normal')).toBe('second');
    });
  });

  describe('nth weekday of a month', () => {
    it.each([
      [2026, 26],
      [2027, 25],
      [2028, 23],
      [2029, 22],
      [2030, 28],
    ])('finds Thanksgiving %i on 26/25/23/22/28 November', (year, date) => {
      expect(pick(year, 11, date)).toBe('thanksgiving');
      expect(pick(year, 11, date - 7)).toBe('autumn');
      expect(pick(year, 11, date + 1)).toBe('autumn');
    });
  });

  describe('validation', () => {
    it.each([
      [{ theme: 'x', on: '13-01' }],
      [{ theme: 'x', on: '1-5' }],
      [{ theme: 'x', from: '09-01', to: '11-31x' }],
      [{ theme: 'x', nth: { n: 1, weekday: 'mon', month: 13 } }],
    ])('rejects a malformed entry at load rather than on the day: %j', (entry) => {
      expect(() => validateCalendar([entry as CalendarEntry])).toThrow();
    });

    it('rejects a malformed calendar when the automation is created', () => {
      expect(() => makeThemeCalendarAutomation({ location: 'g', calendar: [{ theme: 'x', on: '02-30x' as '02-30' }] })).toThrow();
    });
  });
});

// ── Automation ──────────────────────────────────────────────────────────────────

const LOCATION = 'test_garden';
const THEME = `input_select.${LOCATION}_light_theme`;
const TOGGLE = `input_boolean.${LOCATION}_light_theme_calendar_enabled`;
const OPTIONS = ['normal', 'autumn', 'halloween', 'bonfire', 'christmas'];
const automation = makeThemeCalendarAutomation({ location: LOCATION, calendar: CALENDAR, fallback: 'normal' });

const daily = { type: 'schedule' as const, cron: CALENDAR_CRON, correlation_id: 'test-cid' };
const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };

function run(event: typeof daily | typeof onStart, theme: string, extra: Record<string, { state: string; attributes?: Record<string, unknown> }> = {}) {
  return testAutomation(automation, {
    event,
    state: { [TOGGLE]: { state: 'on' }, [THEME]: { state: theme, attributes: { options: OPTIONS } }, ...extra },
  });
}

// Just after midnight local time, when the daily check runs.
const at = (y: number, m: number, d: number, h = 0, min = 5) => vi.setSystemTime(new Date(y, m - 1, d, h, min));
const selectCall = (option: string) =>
  expect.objectContaining({ domain: 'input_select', service: 'select_option', target: { entity_id: THEME }, data: { option } });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('following the calendar', () => {
  it('checks daily just after midnight, when the garden is already off', () => {
    expect(automation.triggers).toContainEqual({ type: 'schedule', cron: '5 0 * * *' });
  });

  describe('on the day the calendar changes', () => {
    it.each([
      ['Halloween starts', [2026, 10, 20], 'autumn', 'halloween'],
      ['Halloween ends', [2026, 11, 1], 'halloween', 'autumn'],
      ['Bonfire Night starts', [2026, 11, 5], 'autumn', 'bonfire'],
      ['Bonfire Night ends', [2026, 11, 6], 'bonfire', 'autumn'],
      ['Christmas starts', [2026, 12, 1], 'autumn', 'christmas'],
      ['the new year begins', [2027, 1, 1], 'christmas', 'normal'],
    ] as const)('switches the theme when %s', (_name, [y, m, d], from, to) => {
      at(y, m, d);
      const result = run(daily, from);
      expect(result).toMatchObject({ decision: 'switch_theme', reason: 'calendar_boundary' });
      expect(result.actions).toEqual([selectCall(to)]);
    });

    it('overrides an earlier manual pick — a manual pick only lasts until the next change', () => {
      at(2026, 11, 1);
      const result = run(daily, 'normal');
      expect(result.actions).toEqual([selectCall('autumn')]);
    });

    it('does nothing if the theme was already set to the new one by hand', () => {
      at(2026, 12, 1);
      expect(run(daily, 'christmas')).toMatchObject({ decision: 'no_action', reason: 'already_on_todays_theme' });
    });
  });

  describe('on any other day', () => {
    it.each([
      ['mid-Autumn', [2026, 10, 1]],
      ['mid-Halloween', [2026, 10, 30]],
      ['mid-winter', [2027, 2, 1]],
    ] as const)('leaves a manual pick alone %s', (_name, [y, m, d]) => {
      at(y, m, d);
      const result = run(daily, 'bonfire');
      expect(result).toMatchObject({ decision: 'no_action', reason: 'not_a_calendar_boundary' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('after a restart', () => {
    it('catches up a switch missed while homerun was down, if the theme is still yesterday\'s', () => {
      at(2026, 11, 5, 9, 0);
      const result = run(onStart, 'autumn');
      expect(result).toMatchObject({ decision: 'switch_theme', reason: 'calendar_boundary_catch_up' });
      expect(result.actions).toEqual([selectCall('bonfire')]);
    });

    it('leaves the theme alone if someone already changed it by hand today', () => {
      at(2026, 11, 5, 9, 0);
      expect(run(onStart, 'normal')).toMatchObject({ decision: 'no_action', reason: 'theme_changed_by_hand_today' });
    });

    it('does nothing on a day the calendar does not change', () => {
      at(2026, 11, 10, 9, 0);
      expect(run(onStart, 'normal')).toMatchObject({ decision: 'no_action', reason: 'not_a_calendar_boundary' });
    });
  });

  describe('when the calendar names a theme the selector does not offer', () => {
    it('leaves the theme alone and says why, rather than selecting an invalid option', () => {
      at(2026, 11, 26);
      const result = testAutomation(automation, {
        event: daily,
        state: { [TOGGLE]: { state: 'on' }, [THEME]: { state: 'autumn', attributes: { options: OPTIONS } } },
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'calendar_theme_not_an_option:thanksgiving' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('when "Follow calendar" is switched off', () => {
    it('never changes the theme, even on a boundary day', () => {
      at(2026, 11, 5);
      const result = run(daily, 'autumn', { [TOGGLE]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'calendar_disabled' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('misconfiguration', () => {
    it('aborts when the toggle helper is missing or unavailable', () => {
      at(2026, 11, 5);
      expect(testAbort(automation, { event: daily, state: { [THEME]: { state: 'autumn', attributes: { options: OPTIONS } } } }).reason)
        .toContain('calendar_toggle_unavailable');
      expect(testAbort(automation, { event: daily, state: { [TOGGLE]: { state: 'unavailable' }, [THEME]: { state: 'autumn' } } }).reason)
        .toContain('calendar_toggle_unavailable');
    });

    it('aborts when the theme selector is unavailable', () => {
      at(2026, 11, 5);
      expect(testAbort(automation, { event: daily, state: { [TOGGLE]: { state: 'on' }, [THEME]: { state: 'unavailable' } } }).reason)
        .toContain('theme_select_unavailable');
    });
  });
});
