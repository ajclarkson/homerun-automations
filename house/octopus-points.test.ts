import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './octopus-points.js';

const POINTS = 'sensor.octopus_energy_a_644e00d3_octoplus_points';

const pointsChanged = (oldState: string | undefined, newState: string) => ({
  type: 'state_changed' as const,
  entity_id: POINTS,
  old_state: oldState === undefined ? undefined : { entity_id: POINTS, state: oldState, attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: POINTS, state: newState, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const run = (oldState: string | undefined, newState: string) =>
  testAutomation(automation, { event: pointsChanged(oldState, newState), state: {} });

describe('octopoints credited — notification', () => {
  it('reports the amount credited and the new balance', () => {
    const action = run('1000', '1250').actions[0] as unknown as { data: { message: string } };
    expect(action.data.message).toBe('+250 octopoints (balance 1250)');
  });

  it('tells both Adam and Sarah', () => {
    const services = (run('10', '20').actions as { service: string }[]).map((a) => a.service);
    expect(services).toEqual(['mobile_app_adams_iphone', 'mobile_app_sarahs_iphone']);
  });

  it('does not claim a source for the credit', () => {
    const action = run('10', '20').actions[0] as unknown as { data: { title: string; message: string } };
    expect(`${action.data.title} ${action.data.message}`).not.toMatch(/wheel|spin|session|power down/i);
  });
});

describe('octopoints credited — no notification', () => {
  it.each([
    ['the balance is unchanged', '100', '100', 'balance_not_increased'],
    ['the balance goes down (points redeemed)', '100', '40', 'balance_not_increased'],
    ['the sensor was unavailable and recovers', 'unavailable', '1250', 'balance_not_numeric'],
    ['the sensor was unknown and recovers', 'unknown', '1250', 'balance_not_numeric'],
    ['the sensor goes unavailable', '1250', 'unavailable', 'balance_not_numeric'],
    ['the previous balance was blank', '', '1250', 'balance_not_numeric'],
  ])('stays quiet when %s', (_label, before, after, reason) => {
    expect(testAbort(automation, { event: pointsChanged(before, after), state: {} })).toMatchObject({ reason });
  });

  it('stays quiet when the entity is first seen (no previous state)', () => {
    expect(testAbort(automation, { event: pointsChanged(undefined, '1250'), state: {} })).toMatchObject({ reason: 'balance_not_numeric' });
  });
});
