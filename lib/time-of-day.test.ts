import { describe, it, expect } from 'vitest';
import { minutesSinceNoon, parseTimeOfDay, formatTimeOfDay } from './time-of-day.js';

describe('minutesSinceNoon', () => {
  it.each([
    [12, 0, 0],
    [20, 0, 480],
    [23, 59, 719],
    [0, 0, 720],
    [1, 30, 810],
    [2, 0, 840],
    [11, 59, 1439],
  ])('%i:%i is %i minutes after noon', (h, m, expected) => {
    expect(minutesSinceNoon(h, m)).toBe(expected);
  });

  it('counts the small hours as later than the evening, so 02:00 is never before 20:00', () => {
    expect(minutesSinceNoon(2, 0)).toBeGreaterThan(minutesSinceNoon(20, 0));
  });

  it.each([[24, 0], [-1, 0], [1.5, 0], [0, 60], [0, -1]])('rejects the impossible time %s:%s', (h, m) => {
    expect(() => minutesSinceNoon(h, m)).toThrow();
  });
});

describe('parseTimeOfDay', () => {
  it.each([
    ['20:00:00', 1200],
    ['20:00', 1200],
    ['00:00:00', 0],
    ['23:59:59', 1439],
  ])('reads %s', (text, expected) => {
    expect(parseTimeOfDay(text)).toBe(expected);
  });

  it.each(['unavailable', 'unknown', 'bogus', '', '24:00:00', '20:60', '2026-11-16', '8:00', undefined, null, 20])('rejects %s', (text) => {
    expect(parseTimeOfDay(text)).toBeNull();
  });
});

describe('formatTimeOfDay', () => {
  it('pads hours and minutes', () => {
    expect(formatTimeOfDay(0)).toBe('00:00');
    expect(formatTimeOfDay(965)).toBe('16:05');
    expect(formatTimeOfDay(1439)).toBe('23:59');
  });

  it.each([-1, 1440, 1.5, NaN])('rejects %s', (m) => {
    expect(() => formatTimeOfDay(m)).toThrow();
  });
});
