import { describe, it, expect } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
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

    expect(result).toMatchObject({ decision: 'guest_active', reason: 'guest_present', outcome: 'acted' });
    expect(result.facts).toEqual({ modifier: 'guest' });
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'input_boolean',
      service: 'turn_on',
      target: { entity_id: HOME_OFFICE_OVERRIDE },
    }]);
  });

  it('turns off home office presence override when modifier returns to none', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'none' } },
      state: { 'input_select.house_active_mode_modifier': { state: 'none' } },
    });

    expect(result).toMatchObject({ decision: 'guest_inactive', reason: 'guest_absent', outcome: 'acted' });
    expect(result.facts).toEqual({ modifier: 'none' });
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'input_boolean',
      service: 'turn_off',
      target: { entity_id: HOME_OFFICE_OVERRIDE },
    }]);
  });

  it('turns off home office presence override when modifier is sitter', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'sitter' } },
      state: { 'input_select.house_active_mode_modifier': { state: 'sitter' } },
    });

    expect(result).toMatchObject({ decision: 'guest_inactive', reason: 'guest_absent', outcome: 'acted' });
    expect(result.facts).toEqual({ modifier: 'sitter' });
    expect(result.actions).toEqual([{
      type: 'ha.call_service',
      domain: 'input_boolean',
      service: 'turn_off',
      target: { entity_id: HOME_OFFICE_OVERRIDE },
    }]);
  });

  it('aborts when modifier is unavailable', () => {
    const result = testAbort(automation, {
      event: trigger,
      state: { 'input_select.house_active_mode_modifier': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/modifier_unavailable/);
  });

  it('aborts when modifier entity is missing from state', () => {
    testAbort(automation, {
      event: trigger,
      state: {},
    });
  });

  describe('after a homerun restart', () => {
    const onStart = { type: 'on_start' as const, correlation_id: 'test' };
    it.each([['guest', 'guest_present_startup'], ['none', 'guest_absent_startup']])('modifier %s is %s and ignored', (modifier, reason) => {
      const result = testAutomation(automation, { event: onStart, state: { 'input_select.house_active_mode_modifier': { state: modifier } } });
      expect(result).toMatchObject({ reason, outcome: 'ignored' });
      expect(result.facts).toEqual({ modifier });
      expect(result.actions).toHaveLength(1);
    });
  });
});
