import { describe, it, expect } from 'vitest';
import { testAutomation, testUnavailable } from '@ajclarkson/homerun/testing';
import automation from './manual-privacy-toggle.js';

const trigger = {
  type: 'button' as const,
  entity_id: 'sensor.hallway_downstairs_button_wall_action',
  gesture: 'double_press' as const,
  correlation_id: 'test',
};

describe('house:manual-privacy-toggle', () => {
  it('turns off cameras privacy when privacy is currently on', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'switch.parlour_privacy': { state: 'on' } },
    });

    expect(result.decision).toBe('disable_privacy');
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'switch',
      service: 'turn_off',
      target: { entity_id: 'group.cameras_privacy' },
    }]);
  });

  it('turns on cameras privacy when privacy is currently off', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'switch.parlour_privacy': { state: 'off' } },
    });

    expect(result.decision).toBe('enable_privacy');
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'switch',
      service: 'turn_on',
      target: { entity_id: 'group.cameras_privacy' },
    }]);
  });

  it('aborts when privacy switch is unavailable', () => {
    const entityId = testUnavailable(automation, {
      event: trigger,
      state: { 'switch.parlour_privacy': { state: 'unavailable' } },
    });

    expect(entityId).toBe('switch.parlour_privacy');
  });

  it('aborts when privacy switch is missing from state', () => {
    const entityId = testUnavailable(automation, {
      event: trigger,
      state: {},
    });

    expect(entityId).toBe('switch.parlour_privacy');
  });
});
