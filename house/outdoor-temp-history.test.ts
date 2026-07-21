import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './outdoor-temp-history.js';

const TODAY = '2026-07-21';
const YESTERDAY = '2026-07-20';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(`${TODAY}T23:00:00.000Z`)); });
afterEach(() => vi.useRealTimers());

const scheduleEvent = { type: 'schedule' as const, cron: '0 23 * * *', correlation_id: 'test-cid' };

const baseState = {
  'weather.forecast_home': { state: 'sunny', attributes: { temperature: 22.5 } },
  'input_text.outdoor_temp_7day_history': { state: JSON.stringify({ date: YESTERDAY, temps: [18, 19, 20, 21, 22, 23, 24] }) },
};

function run(override: Record<string, unknown> = {}) {
  return testAutomation(automation, { event: scheduleEvent, state: { ...baseState, ...override } });
}

function getWrittenHistory(actions: unknown[]): { date: string; temps: number[] } {
  const action = actions.find((a: unknown) =>
    (a as { domain?: string }).domain === 'input_text'
  ) as { data: { value: string } } | undefined;
  return JSON.parse(action?.data.value ?? '{}');
}

describe('recording', () => {
  it('appends today high and shifts oldest when at 7 entries', () => {
    const result = run();
    expect(result.decision).toBe('record');
    expect(result.reason).toBe('end_of_day');
    const written = getWrittenHistory(result.actions);
    expect(written.date).toBe(TODAY);
    expect(written.temps).toEqual([19, 20, 21, 22, 23, 24, 22.5]);
  });

  it('appends without shifting when fewer than 7 entries', () => {
    const result = run({
      'input_text.outdoor_temp_7day_history': { state: JSON.stringify({ date: YESTERDAY, temps: [20, 21] }) },
    });
    const written = getWrittenHistory(result.actions);
    expect(written.temps).toEqual([20, 21, 22.5]);
  });

  it('writes the correct date', () => {
    const result = run();
    expect(getWrittenHistory(result.actions).date).toBe(TODAY);
  });

  it('handles empty history (first ever run)', () => {
    const result = run({ 'input_text.outdoor_temp_7day_history': { state: '' } });
    const written = getWrittenHistory(result.actions);
    expect(written.temps).toEqual([22.5]);
    expect(written.date).toBe(TODAY);
  });

  it('handles malformed history JSON gracefully', () => {
    const result = run({ 'input_text.outdoor_temp_7day_history': { state: 'not-json' } });
    const written = getWrittenHistory(result.actions);
    expect(written.temps).toEqual([22.5]);
  });
});

describe('de-duplication', () => {
  it('skips if already recorded today', () => {
    const result = run({
      'input_text.outdoor_temp_7day_history': { state: JSON.stringify({ date: TODAY, temps: [22.5] }) },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('already_recorded_today');
    expect(result.actions).toHaveLength(0);
  });
});

describe('abort conditions', () => {
  it('aborts when forecast temperature is unavailable', () => {
    const result = testAbort(automation, {
      event: scheduleEvent,
      state: { ...baseState, 'weather.forecast_home': { state: 'sunny', attributes: {} } },
    });
    expect(result.reason).toBe('forecast_temperature_unavailable');
  });
});
