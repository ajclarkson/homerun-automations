import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './away-detection.js';

const RECENTLY = new Date(Date.now() - 10 * 60 * 1000).toISOString();
const STALE = new Date(Date.now() - 60 * 60 * 1000).toISOString();

const VACATION_THRESHOLD = 'input_number.house_automation_vacation_threshold_hours';
const VACATION_TIMER_KEY = 'house:house_mode:vacation_promotion';
const cancelVacationTimer = { type: 'timer.cancel', timerKey: VACATION_TIMER_KEY };

const zoneTrigger = {
  type: 'state_changed' as const,
  entity_id: 'zone.home',
  old_state: { entity_id: 'zone.home', state: '1', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'zone.home', state: '0', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

const baseState = {
  'zone.home': { state: '0' },
  'sensor.house_active_mode': { state: 'normal' },
  'binary_sensor.external_doors_state': { state: 'off', last_changed: RECENTLY },
  'input_select.house_active_mode_modifier': { state: 'none' },
};

const modifierEndedTrigger = {
  type: 'state_changed' as const,
  entity_id: 'input_select.house_active_mode_modifier',
  old_state: { entity_id: 'input_select.house_active_mode_modifier', state: 'sitter', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'input_select.house_active_mode_modifier', state: 'none', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test',
};

describe('house:away-detection', () => {
  it('sets away mode when nobody is home and a door changed recently', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: baseState,
    });

    expect(result.decision).toBe('set_away');
    expect(result.reason).toBe('all_left_door_recently');
    expect(result.actions).toEqual([
      cancelVacationTimer,
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('does nothing when nobody is home but no door event recently', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: {
        ...baseState,
        'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
      },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('no_door_event');
    expect(result.actions).toEqual([cancelVacationTimer]);
  });

  it('sets normal mode when someone returns home and house was away', () => {
    const result = testAutomation(automation, {
      event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
      state: {
        ...baseState,
        'zone.home': { state: '1' },
        'sensor.house_active_mode': { state: 'away' },
      },
    });

    expect(result.decision).toBe('set_normal');
    expect(result.reason).toBe('someone_returned');
    expect(result.actions).toEqual([
      cancelVacationTimer,
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('does nothing when someone is home and house is already normal', () => {
    const result = testAutomation(automation, {
      event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
      state: { ...baseState, 'zone.home': { state: '1' } },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_in_away_mode');
    expect(result.actions).toEqual([cancelVacationTimer]);
  });

  it('does not override vacation or sleep mode on arrival', () => {
    for (const mode of ['vacation', 'sleep']) {
      const result = testAutomation(automation, {
        event: { ...zoneTrigger, new_state: { ...zoneTrigger.new_state, state: '1' } },
        state: {
          ...baseState,
          'zone.home': { state: '1' },
          'sensor.house_active_mode': { state: mode },
        },
      });

      expect(result.decision).toBe('no_action');
      expect(result.actions).toEqual([cancelVacationTimer]);
    }
  });

  it('aborts when zone.home is unavailable', () => {
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: { ...baseState, 'zone.home': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/zone_home_unavailable/);
  });

  it('aborts when house mode is missing', () => {
    const { 'sensor.house_active_mode': _removed, ...stateWithoutMode } = baseState;
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: stateWithoutMode,
    });

    expect(result.reason).toBe('house_mode_unavailable');
  });

  it('aborts when doors entity is missing', () => {
    const { 'binary_sensor.external_doors_state': _removed, ...stateWithoutDoors } = baseState;
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: stateWithoutDoors,
    });

    expect(result.reason).toBe('doors_entity_missing');
  });

  it('aborts when the mode modifier is unavailable', () => {
    const result = testAbort(automation, {
      event: zoneTrigger,
      state: { ...baseState, 'input_select.house_active_mode_modifier': { state: 'unavailable' } },
    });

    expect(result.reason).toMatch(/modifier_unavailable/);
  });

  it('does not go away when a sitter is present even if nobody is tracked home and a door recently changed', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: { ...baseState, 'input_select.house_active_mode_modifier': { state: 'sitter' } },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('sitter_present');
    expect(result.actions).toEqual([cancelVacationTimer]);
  });

  it('exits away mode as soon as a sitter is set while the house is already away', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: {
        ...baseState,
        'sensor.house_active_mode': { state: 'away' },
        'input_select.house_active_mode_modifier': { state: 'sitter' },
      },
    });

    expect(result.decision).toBe('set_normal');
    expect(result.reason).toBe('sitter_present');
    expect(result.actions).toEqual([
      cancelVacationTimer,
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('also exits vacation mode as soon as a sitter is set', () => {
    const result = testAutomation(automation, {
      event: zoneTrigger,
      state: {
        ...baseState,
        'sensor.house_active_mode': { state: 'vacation' },
        'input_select.house_active_mode_modifier': { state: 'sitter' },
      },
    });

    expect(result.decision).toBe('set_normal');
    expect(result.reason).toBe('sitter_present');
    expect(result.actions).toEqual([
      cancelVacationTimer,
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('goes straight to away when sitter mode is ended remotely and nobody is tracked home, even with no recent door event', () => {
    const result = testAutomation(automation, {
      event: modifierEndedTrigger,
      state: {
        ...baseState,
        'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
        'input_select.house_active_mode_modifier': { state: 'none' },
      },
    });

    expect(result.decision).toBe('set_away');
    expect(result.reason).toBe('sitter_mode_ended_house_empty');
    expect(result.actions).toEqual([
      cancelVacationTimer,
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' },
    ]);
  });

  it('does not re-trigger away when sitter mode ends but someone is already tracked home', () => {
    const result = testAutomation(automation, {
      event: modifierEndedTrigger,
      state: {
        ...baseState,
        'zone.home': { state: '1' },
        'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
        'input_select.house_active_mode_modifier': { state: 'none' },
      },
    });

    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_in_away_mode');
    expect(result.actions).toEqual([cancelVacationTimer]);
  });

  describe('promoting a long-running away to vacation', () => {
    const awayFor30Hours = new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const awayFor2Hours = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

    it('promotes to vacation once away has held longer than the configured threshold', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor30Hours },
          [VACATION_THRESHOLD]: { state: '24' },
        },
      });

      expect(result.decision).toBe('set_vacation');
      expect(result.reason).toBe('away_duration_exceeded');
      expect(result.actions).toEqual([
        cancelVacationTimer,
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'vacation', impliesEntity: 'sensor.house_active_mode' },
      ]);
    });

    it('does not promote while away has held for less than the threshold', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor2Hours },
          [VACATION_THRESHOLD]: { state: '24' },
        },
      });

      expect(result.decision).toBe('set_away'); // all_left_door_recently still fires from the door window
      expect(result.reason).not.toBe('away_duration_exceeded');
    });

    it('starts a promotion timer for the remaining time while pending', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor2Hours },
          'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
          [VACATION_THRESHOLD]: { state: '24' },
        },
      });

      const timer = result.actions.find(a => a.type === 'timer.start');
      expect(timer).toBeDefined();
      expect((timer as any).timerKey).toBe(VACATION_TIMER_KEY);
      expect((timer as any).delayMs).toBeCloseTo(22 * 60 * 60 * 1000, -3);
    });

    it('does not promote when the vacation threshold helper is unavailable', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor30Hours },
          'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
          [VACATION_THRESHOLD]: { state: 'unavailable' },
        },
      });

      expect(result.reason).not.toBe('away_duration_exceeded');
      expect(result.actions).toEqual([cancelVacationTimer]);
    });

    it('does not promote when the away-since timestamp is unknown', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away' }, // no last_changed
          [VACATION_THRESHOLD]: { state: '24' },
        },
      });

      expect(result.reason).not.toBe('away_duration_exceeded');
    });

    it('clamps an excessive threshold to MAX_VACATION_THRESHOLD_HOURS', () => {
      const result = testAutomation(automation, {
        event: zoneTrigger,
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor2Hours },
          'binary_sensor.external_doors_state': { state: 'off', last_changed: STALE },
          [VACATION_THRESHOLD]: { state: '99999' },
        },
      });

      // threshold clamps to 168h; away has already held for 2h, so ~166h remains
      const timer = result.actions.find(a => a.type === 'timer.start');
      expect((timer as any).delayMs).toBeCloseTo(166 * 60 * 60 * 1000, -4);
    });

    it('re-evaluates and promotes to vacation when the promotion timer expires with away still held', () => {
      const result = testAutomation(automation, {
        event: { type: 'timer_expired', timerKey: VACATION_TIMER_KEY, correlation_id: 'test' },
        state: {
          ...baseState,
          'sensor.house_active_mode': { state: 'away', last_changed: awayFor30Hours },
          [VACATION_THRESHOLD]: { state: '24' },
        },
      });

      expect(result.decision).toBe('set_vacation');
      expect(result.reason).toBe('away_duration_exceeded');
    });
  });
});
