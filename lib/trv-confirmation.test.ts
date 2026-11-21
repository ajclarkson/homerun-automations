import { describe, it, expect } from 'vitest';
import { isTrvUnconfirmed, unconfirmedRooms, STALE_AFTER_MS } from './trv-confirmation.js';

const NOW = Date.parse('2026-11-21T23:30:00Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const HOUR = 3_600_000;

const input = (over: Partial<Parameters<typeof isTrvUnconfirmed>[0]> = {}) => ({
  numberState: '1869', numberUpdatedAt: ago(11 * HOUR), roomTempState: '19.41', nowMs: NOW, ...over,
});

describe('a TRV whose temperature feed is not confirmed', () => {
  it('is flagged when the number disagrees with the room and has not updated for hours (2026-11-21 bedroom)', () => {
    expect(isTrvUnconfirmed(input({ numberState: '1869', roomTempState: '19.41' }))).toBe(true);
  });

  it('is not flagged in a steady room whose number is old but matches the sensor', () => {
    expect(isTrvUnconfirmed(input({ numberState: '1941', roomTempState: '19.41' }))).toBe(false);
    expect(isTrvUnconfirmed(input({ numberState: '1930', roomTempState: '19.41' }))).toBe(false);
  });

  it('is not flagged for a fresh mismatch inside the stale threshold', () => {
    expect(isTrvUnconfirmed(input({ numberUpdatedAt: ago(STALE_AFTER_MS - 1000) }))).toBe(false);
    expect(isTrvUnconfirmed(input({ numberUpdatedAt: ago(STALE_AFTER_MS + 1000) }))).toBe(true);
  });

  it('is not flagged for a mismatch exactly at the tolerance', () => {
    expect(isTrvUnconfirmed(input({ numberState: '1911', roomTempState: '19.41' }))).toBe(false);
    expect(isTrvUnconfirmed(input({ numberState: '1910', roomTempState: '19.41' }))).toBe(true);
  });

  it.each([
    ['number unavailable', { numberState: 'unavailable' }],
    ['number unknown', { numberState: 'unknown' }],
    ['number missing', { numberState: undefined }],
    ['number blank', { numberState: '' }],
    ['number implausible', { numberState: '99999' }],
    ['sensor unavailable', { roomTempState: 'unavailable' }],
    ['sensor missing', { roomTempState: undefined }],
    ['sensor blank', { roomTempState: '' }],
    ['sensor implausible', { roomTempState: '999' }],
    ['timestamp missing', { numberUpdatedAt: undefined }],
    ['timestamp empty', { numberUpdatedAt: '' }],
    ['timestamp garbage', { numberUpdatedAt: 'yesterday' }],
    ['timestamp in the future', { numberUpdatedAt: ago(-HOUR) }],
  ])('cannot be judged, so is not flagged, when %s', (_name, over) => {
    expect(isTrvUnconfirmed(input(over))).toBe(false);
  });

  it('fails loudly when the clock is not a number', () => {
    expect(() => isTrvUnconfirmed(input({ nowMs: NaN }))).toThrow();
  });
});

describe('unconfirmedRooms', () => {
  const entities: Record<string, { state: string; last_updated: string }> = {
    'number.bedroom_trv_external_measured_room_sensor': { state: '1869', last_updated: ago(11 * HOUR) },
    'sensor.bedroom_sensor_climate_temperature': { state: '19.41', last_updated: ago(1000) },
    'number.parlour_trv_external_measured_room_sensor': { state: '2000', last_updated: ago(11 * HOUR) },
    'sensor.parlour_sensor_climate_temperature': { state: '20.0', last_updated: ago(1000) },
  };

  it('lists only the stale-and-mismatched rooms, ignoring rooms with no entities', () => {
    expect(unconfirmedRooms(['parlour', 'bedroom', 'kitchen'], id => entities[id], NOW)).toEqual(['bedroom']);
  });
});
