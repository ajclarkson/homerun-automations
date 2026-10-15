import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './octopus-power-down.js';

const ENTITY = 'event.octopus_energy_a_644e00d3_octoplus_power_down_events';

const session = (code: string, start: string, end: string, octopoints_per_kwh = 24) => ({
  id: `id-${code}`, code, start, end, duration_in_minutes: 60, octopoints_per_kwh,
});

const stateChanged = {
  type: 'state_changed' as const,
  entity_id: ENTITY,
  old_state: { entity_id: ENTITY, state: '2026-10-14T10:00:00', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: ENTITY, state: '2026-10-15T10:00:00', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
};
const scheduled = { type: 'schedule' as const, cron: '0 * * * *', correlation_id: 'test-cid' };
const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };

const run = (available: unknown, event: Parameters<typeof testAutomation>[1]['event'] = stateChanged) =>
  testAutomation(automation, {
    event,
    state: { [ENTITY]: { state: '2026-10-15T10:00:00', attributes: { available_events: available } } },
  });

const joins = (actions: unknown[]) =>
  (actions as { service: string; data: { event_code?: string } }[]).filter((a) => a.service === 'join_octoplus_power_down_session_event');
const notifies = (actions: unknown[]) =>
  (actions as { domain: string; service: string }[]).filter((a) => a.domain === 'notify');

describe('power down auto-join — joining announced sessions', () => {
  const one = [session('abc', '2026-10-20T17:30:00+01:00', '2026-10-20T18:30:00+01:00')];

  it('joins a newly announced session using its event code', () => {
    const result = run(one);
    expect(result.decision).toBe('join');
    expect(joins(result.actions)).toEqual([
      expect.objectContaining({
        domain: 'octopus_energy',
        target: { entity_id: ENTITY },
        data: { event_code: 'abc' },
      }),
    ]);
  });

  it('joins every available session when several are announced together', () => {
    const result = run([
      ...one,
      session('def', '2026-10-22T17:30:00+01:00', '2026-10-22T18:30:00+01:00'),
    ]);
    expect(joins(result.actions).map((a) => a.data.event_code)).toEqual(['abc', 'def']);
  });

  it.each([
    ['the events entity updates', stateChanged],
    ['the hourly safety-net runs', scheduled],
    ['homerun starts', onStart],
  ])('joins available sessions when %s', (_label, event) => {
    expect(joins(run(one, event).actions)).toHaveLength(1);
  });
});

describe('power down auto-join — nothing to join', () => {
  it('does nothing when every session is already joined (available_events empty)', () => {
    expect(testAbort(automation, {
      event: stateChanged,
      state: { [ENTITY]: { state: 'x', attributes: { available_events: [] } } },
    })).toMatchObject({ reason: 'no_sessions_to_join' });
  });

  it('does nothing when the attribute is missing', () => {
    expect(testAbort(automation, {
      event: stateChanged,
      state: { [ENTITY]: { state: 'x', attributes: {} } },
    })).toMatchObject({ reason: 'no_sessions_to_join' });
  });

  it('does nothing when the entity is unavailable', () => {
    expect(testAbort(automation, { event: scheduled, state: {} })).toMatchObject({ reason: 'no_sessions_to_join' });
  });

  it('ignores malformed entries rather than joining with a bad code', () => {
    expect(testAbort(automation, {
      event: stateChanged,
      state: { [ENTITY]: { state: 'x', attributes: { available_events: [{ start: 'a', end: 'b' }, null, 'junk'] } } },
    })).toMatchObject({ reason: 'no_sessions_to_join' });
  });
});

describe('power down auto-join — notification', () => {
  const result = run([session('abc', '2026-10-20T17:30:00+01:00', '2026-10-20T18:30:00+01:00', 24)]);

  it('tells both Adam and Sarah, regardless of who is home', () => {
    expect(notifies(result.actions).map((a) => a.service)).toEqual(['mobile_app_adams_iphone', 'mobile_app_sarahs_iphone']);
  });

  it('describes the day, time window and reward in UK time', () => {
    const action = notifies(result.actions)[0] as unknown as { data: { message: string } };
    expect(action.data.message).toBe('Tue 20 Oct 17:30–18:30 · 24 octopoints/kWh');
  });
});
