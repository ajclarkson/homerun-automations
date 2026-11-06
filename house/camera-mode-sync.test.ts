import { describe, it, expect } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from '../lib/declared-outcome.js';
import automation from './camera-mode-sync.js';

const trigger = {
  type: 'state_changed' as const,
  entity_id: 'sensor.house_active_mode',
  old_state: { entity_id: 'sensor.house_active_mode', state: 'normal', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.house_active_mode', state: 'away', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const baseState = {
  'sensor.house_active_mode': { state: 'normal' },
  'input_select.house_active_mode_modifier': { state: 'none' },
};

describe('house:camera-mode-sync', () => {
  it('turns cameras on when house goes away with no guest', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'away' } },
    });

    expect(result).toMatchObject({ decision: 'cameras_on', reason: 'house_away', outcome: 'acted' });
    expect(result.reason).toBe('house_away');
    expect(result.outcome).toBe('acted');
    expect(result.actions).toEqual([
      { type: 'ha.call_service', domain: 'switch', service: 'turn_off', target: { entity_id: 'group.cameras_privacy' } },
    ]);
  });

  it('does nothing when house is away but guest is present', () => {
    const result = testAutomation(automation, {
      event: trigger,
      state: { 'sensor.house_active_mode': { state: 'away' }, 'input_select.house_active_mode_modifier': { state: 'guest' } },
    });

    expect(result).toMatchObject({ decision: 'no_action', reason: 'away_but_guest_present', outcome: 'declined' });
    expect(result.reason).toBe('away_but_guest_present');
    expect(result.outcome).toBe('declined');
    expect(result.actions).toHaveLength(0);
  });

  it('turns all cameras off but keeps kitchen on for Mo monitoring during sleep', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'sleep' } },
      state: { ...baseState, 'sensor.house_active_mode': { state: 'sleep' } },
    });

    expect(result).toMatchObject({ decision: 'sleep_mo_monitoring', reason: 'sleep_kitchen_camera_on', outcome: 'acted' });
    expect(result.actions).toEqual([
      { type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: 'group.cameras_privacy' } },
      { type: 'ha.call_service', domain: 'switch', service: 'turn_off', target: { entity_id: 'switch.kitchen_privacy' } },
    ]);
  });

  it('turns cameras off when house returns to normal', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'normal' } },
      state: baseState,
    });

    expect(result).toMatchObject({ decision: 'cameras_off', reason: 'house_not_away', outcome: 'acted' });
    expect(result.reason).toBe('house_not_away');
    expect(result.outcome).toBe('acted');
    expect(result.actions).toEqual([
      { type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: 'group.cameras_privacy' } },
    ]);
  });

  it('does nothing for unmanaged modes like vacation', () => {
    const result = testAutomation(automation, {
      event: { ...trigger, new_state: { ...trigger.new_state, state: 'vacation' } },
      state: { ...baseState, 'sensor.house_active_mode': { state: 'vacation' } },
    });

    expect(result).toMatchObject({ decision: 'no_action', reason: 'mode_not_managed', outcome: 'ignored' });
    expect(result.facts).toEqual({ mode: 'vacation' });
    expect(result.reason).toBe('mode_not_managed');
    expect(result.outcome).toBe('ignored');
    expect(result.facts).toEqual({ mode: 'vacation' });
    expect(result.outcome).toBe('ignored');
    expect(result.actions).toHaveLength(0);
  });

  describe('a guest arriving while the house is away', () => {
    const modifierChange = (from: string, to: string) => ({
      type: 'state_changed' as const,
      entity_id: 'input_select.house_active_mode_modifier',
      old_state: { entity_id: 'input_select.house_active_mode_modifier', state: from, attributes: {}, last_changed: '', last_updated: '' },
      new_state: { entity_id: 'input_select.house_active_mode_modifier', state: to, attributes: {}, last_changed: '', last_updated: '' },
      correlation_id: 'test',
    });
    const awayWithGuest = (privacy: string) => ({
      'sensor.house_active_mode': { state: 'away' },
      'input_select.house_active_mode_modifier': { state: 'guest' },
      'switch.parlour_privacy': { state: privacy },
    });

    it('switches the cameras off when they were watching the empty house', () => {
      const result = testAutomation(automation, { event: modifierChange('none', 'guest'), state: awayWithGuest('off') });

      expect(result).toMatchObject({ decision: 'cameras_off', reason: 'guest_arrived_while_away', outcome: 'acted' });
      expect(result.actions).toEqual([
        { type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: 'group.cameras_privacy' } },
      ]);
    });

    it('leaves the cameras alone when privacy was already on', () => {
      const result = testAutomation(automation, { event: modifierChange('none', 'guest'), state: awayWithGuest('on') });

      expect(result).toMatchObject({ decision: 'no_action', reason: 'away_but_guest_present', outcome: 'declined' });
      expect(result.actions).toHaveLength(0);
    });

    it('does nothing when the privacy switch is unavailable rather than guessing', () => {
      const result = testAutomation(automation, { event: modifierChange('none', 'guest'), state: awayWithGuest('unavailable') });

      expect(result).toMatchObject({ reason: 'away_but_guest_present', outcome: 'declined' });
      expect(result.actions).toHaveLength(0);
    });

    it('does not treat a house going away with a guest already staying as an arrival', () => {
      const result = testAutomation(automation, { event: trigger, state: awayWithGuest('off') });

      expect(result).toMatchObject({ reason: 'away_but_guest_present', outcome: 'declined' });
      expect(result.actions).toHaveLength(0);
    });

    it('does not treat a restart with a guest already staying as an arrival', () => {
      const result = testAutomation(automation, { event: { type: 'on_start' as const, correlation_id: 'test' }, state: awayWithGuest('off') });

      expect(result).toMatchObject({ reason: 'away_but_guest_present', outcome: 'declined' });
      expect(result.actions).toHaveLength(0);
    });

    it('does not switch cameras off when the guest arrives while someone is home', () => {
      const result = testAutomation(automation, {
        event: modifierChange('none', 'guest'),
        state: { ...awayWithGuest('off'), 'sensor.house_active_mode': { state: 'normal' } },
      });

      expect(result).toMatchObject({ reason: 'house_not_away', outcome: 'acted' });
    });

    it('turns the cameras back on when the guest leaves while the house is still away', () => {
      const result = testAutomation(automation, {
        event: modifierChange('guest', 'none'),
        state: { ...awayWithGuest('on'), 'input_select.house_active_mode_modifier': { state: 'none' } },
      });

      expect(result).toMatchObject({ reason: 'house_away', outcome: 'acted' });
    });
  });

  it('aborts when house mode is unavailable', () => {
    const result = testAbort(automation, {
      event: trigger,
      state: { ...baseState, 'sensor.house_active_mode': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/house_mode_unavailable/);
  });

  it('aborts when modifier is unavailable', () => {
    const result = testAbort(automation, {
      event: trigger,
      state: { ...baseState, 'input_select.house_active_mode_modifier': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/modifier_unavailable/);
  });

  describe('after a homerun restart', () => {
    const onStart = { type: 'on_start' as const, correlation_id: 'test' };
    it.each([
      ['away', 'house_away_startup'],
      ['sleep', 'sleep_kitchen_camera_on_startup'],
      ['normal', 'house_not_away_startup'],
    ])('re-asserts %s without adding history (%s)', (mode, reason) => {
      const result = testAutomation(automation, { event: onStart, state: { ...baseState, 'sensor.house_active_mode': { state: mode } } });
      expect(result).toMatchObject({ reason, outcome: 'ignored' });
      expect(result.actions.length).toBeGreaterThan(0);
    });
  });
});
