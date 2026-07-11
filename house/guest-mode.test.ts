import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import automation from './guest-mode.js';

const trigger = {
  type: 'state_changed' as const,
  entity_id: 'input_select.house_active_mode_modifier',
  old_state: { entity_id: 'input_select.house_active_mode_modifier', state: 'none', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'input_select.house_active_mode_modifier', state: 'guest', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const HOME_OFFICE_OVERRIDE = 'input_boolean.home_office_automation_presence_override';

describe('house:guest-mode', () => {
  it('turns on home office presence override when modifier becomes guest', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'input_select.house_active_mode_modifier': { state: 'guest' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('guest_active');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_on',
        target: { entity_id: HOME_OFFICE_OVERRIDE },
      }]);
    }
  });

  it('turns off home office presence override when modifier returns to none', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'none' } },
      state: { 'input_select.house_active_mode_modifier': { state: 'none' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('guest_inactive');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_off',
        target: { entity_id: HOME_OFFICE_OVERRIDE },
      }]);
    }
  });

  it('turns off home office presence override when modifier is sitter', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'sitter' } },
      state: { 'input_select.house_active_mode_modifier': { state: 'sitter' } },
    });

    expect('abort' in result).toBe(false);
    if (!('abort' in result)) {
      expect(result.decision).toBe('guest_inactive');
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_off',
        target: { entity_id: HOME_OFFICE_OVERRIDE },
      }]);
    }
  });

  it('aborts when modifier is unavailable', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'input_select.house_active_mode_modifier': { state: 'unavailable' } },
    });

    expect('abort' in result).toBe(true);
    if ('abort' in result) {
      expect(result.reason).toMatch(/modifier_unavailable/);
    }
  });

  it('aborts when modifier entity is missing from state', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: {},
    });

    expect('abort' in result).toBe(true);
  });
});
