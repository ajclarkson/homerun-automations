import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './patio-door.js';

const patioDoorTrigger = (open: boolean) => ({
  type: 'state_changed' as const,
  entity_id: 'binary_sensor.parlour_sensor_door_patio_contact',
  old_state: { entity_id: 'binary_sensor.parlour_sensor_door_patio_contact', state: open ? 'off' : 'on', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'binary_sensor.parlour_sensor_door_patio_contact', state: open ? 'on' : 'off',  attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const baseState = {
  'binary_sensor.parlour_sensor_door_patio_contact': { state: 'off' },
  'input_boolean.house_heating_enabled':              { state: 'on' },
  'input_boolean.patio_door_heating_suspended':       { state: 'off' },
};

describe('house:patio_door', () => {
  it('suspends heating when door opens and heating is on', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(true),
      state: { ...baseState, 'binary_sensor.parlour_sensor_door_patio_contact': { state: 'on' } },
    });
    expect(result.decision).toBe('suspend');
    expect(result.actions).toEqual([
      { type: 'timer.cancel', timerKey: 'house:heating:patio_door_grace' },
      { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on',  target: { entity_id: 'input_boolean.patio_door_heating_suspended' } },
      { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_off', target: { entity_id: 'input_boolean.house_heating_enabled' } },
    ]);
  });

  it('restores heating when door closes and was suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: {
        ...baseState,
        'binary_sensor.parlour_sensor_door_patio_contact': { state: 'off' },
        'input_boolean.house_heating_enabled':              { state: 'off' },
        'input_boolean.patio_door_heating_suspended':       { state: 'on' },
      },
    });
    expect(result.decision).toBe('restore');
    expect(result.actions).toEqual([
      { type: 'timer.cancel', timerKey: 'house:heating:patio_door_grace' },
      { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on',  target: { entity_id: 'input_boolean.house_heating_enabled' } },
      { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_off', target: { entity_id: 'input_boolean.patio_door_heating_suspended' } },
    ]);
  });

  it('does nothing when door opens but heating is already off and not suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(true),
      state: {
        ...baseState,
        'binary_sensor.parlour_sensor_door_patio_contact': { state: 'on' },
        'input_boolean.house_heating_enabled':              { state: 'off' },
      },
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('door_open_heating_already_off');
  });

  it('does nothing when door closes and was not suspended', () => {
    const result = testAutomation(automation, {
      event: patioDoorTrigger(false),
      state: baseState,
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('door_closed_not_suspended');
  });

  it('aborts when door sensor is unavailable', () => {
    const result = testAbort(automation, {
      event: patioDoorTrigger(true),
      state: { ...baseState, 'binary_sensor.parlour_sensor_door_patio_contact': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('door_unavailable'));
  });

  it('aborts when heating enabled helper is unavailable', () => {
    const result = testAbort(automation, {
      event: patioDoorTrigger(false),
      state: { ...baseState, 'input_boolean.house_heating_enabled': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('heating_enabled_unavailable'));
  });

  it('aborts when suspended flag is unavailable', () => {
    const result = testAbort(automation, {
      event: patioDoorTrigger(false),
      state: { ...baseState, 'input_boolean.patio_door_heating_suspended': { state: 'unavailable' } },
    });
    expect(result.reason).toEqual(expect.stringContaining('suspended_flag_unavailable'));
  });

  describe('grace period before an open door suspends heating', () => {
    const GRACE_HELPER = 'input_number.global_heating_window_open_grace_minutes';
    const GRACE_TIMER = 'house:heating:patio_door_grace';
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-07T10:00:00.000Z'));
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const openState = (lastChanged: string, graceMinutes = '2') => ({
      ...baseState,
      'binary_sensor.parlour_sensor_door_patio_contact': { state: 'on', last_changed: lastChanged },
      [GRACE_HELPER]: { state: graceMinutes },
    });

    it('leaves heating on while the door has been open less than the grace period', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(true),
        state: openState('2026-01-07T10:00:00.000Z'),
      });
      expect(result.decision).toBe('pending');
      expect(result.actions.some(a => a.type === 'ha.call_service')).toBe(false);
    });

    it('starts a timer for the remaining grace time', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(true),
        state: openState('2026-01-07T09:59:00.000Z'),
      });
      const timer = result.actions.find(a => a.type === 'timer.start' && (a as any).timerKey === GRACE_TIMER);
      expect((timer as any).delayMs).toBeCloseTo(60 * 1000, -2);
    });

    it('suspends heating once the door has been open for the grace period', () => {
      const result = testAutomation(automation, {
        event: { type: 'timer_expired', timerKey: GRACE_TIMER, correlation_id: 'test-cid' },
        state: openState('2026-01-07T09:58:00.000Z'),
      });
      expect(result.decision).toBe('suspend');
    });

    it('does nothing when the grace timer fires after the door has already closed', () => {
      const result = testAutomation(automation, {
        event: { type: 'timer_expired', timerKey: GRACE_TIMER, correlation_id: 'test-cid' },
        state: baseState,
      });
      expect(result.decision).toBe('no_action');
    });

    it('cancels the grace timer when the door closes within the grace period', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(false),
        state: baseState,
      });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: GRACE_TIMER });
    });

    it('suspends immediately when the grace helper is unavailable, failing toward saving heat', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(true),
        state: { ...openState('2026-01-07T10:00:00.000Z'), [GRACE_HELPER]: { state: 'unavailable' } },
      });
      expect(result.decision).toBe('suspend');
    });

    it('suspends immediately when the grace is set to zero', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(true),
        state: openState('2026-01-07T10:00:00.000Z', '0'),
      });
      expect(result.decision).toBe('suspend');
    });

    it('restores heating on door close even if the grace period was still running', () => {
      const result = testAutomation(automation, {
        event: patioDoorTrigger(false),
        state: { ...baseState, 'input_boolean.house_heating_enabled': { state: 'off' }, 'input_boolean.patio_door_heating_suspended': { state: 'on' } },
      });
      expect(result.decision).toBe('restore');
    });
  });
});
