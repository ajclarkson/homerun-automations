import { describe, it, expect } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
import automation from './trv-adaptation.js';

const adaptationTrigger = (room: string, status: string) => ({
  type: 'state_changed' as const,
  entity_id: `sensor.${room}_trv_adaptation_run_status`,
  old_state: { entity_id: `sensor.${room}_trv_adaptation_run_status`, state: '', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `sensor.${room}_trv_adaptation_run_status`, state: status, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

describe('house:trv_adaptation', () => {
  it('notifies both phones when valve characteristic is lost', () => {
    const result = testAutomation(automation, {
      event: adaptationTrigger('parlour', 'Valve Characteristic Lost'),
      state: {},
    });
    expect(result).toMatchObject({ decision: 'notify', reason: 'valve_characteristic_lost', outcome: 'acted' });
    expect(result.facts).toEqual({ room: 'parlour' });
    expect(result.actions).toHaveLength(2);
    expect(result.actions[0]).toMatchObject({ domain: 'notify', service: 'mobile_app_adams_iphone' });
    expect(result.actions[1]).toMatchObject({ domain: 'notify', service: 'mobile_app_sarahs_iphone' });
    const action = result.actions[0] as unknown as { data: { message: string } };
    expect(action.data.message).toContain('parlour');
  });

  it('returns no_action for non-critical status', () => {
    const result = testAutomation(automation, {
      event: adaptationTrigger('bedroom', 'Adaptation Successful'),
      state: {},
    });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'status_not_critical', outcome: 'ignored' });
    expect(result.facts).toEqual({ status: 'Adaptation Successful' });
    expect(result.actions).toHaveLength(0);
  });

  it('aborts when status is unavailable', () => {
    const result = testAbort(automation, {
      event: adaptationTrigger('kitchen', 'unavailable'),
      state: {},
    });
    expect(result.reason).toEqual(expect.stringContaining('status_unavailable'));
  });
});
