import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import { makeOccupancyAutomation } from './occupancy-controller-factory.js';

const LOCATION = 'test_room';
const MOTION_SENSOR = `binary_sensor.${LOCATION}_sensor_motion_occupancy`;
const MOTION_GATE = `input_boolean.${LOCATION}_sensor_motion_enabled`;
const PRESENCE_OVERRIDE = `input_boolean.${LOCATION}_automation_presence_override`;
const DOOR_ENTITY = `binary_sensor.${LOCATION}_sensor_door_front_contact`;
const TIMER_KEY = `${LOCATION}:occupied_clear`;

const automation = makeOccupancyAutomation({ location: LOCATION, delayMins: 2, reopenTightenMins: 1 });
const automationWithDoor = makeOccupancyAutomation({
  location: LOCATION,
  delayMins: 2,
  reopenTightenMins: 1,
  containmentMaxMins: 60,
  extraTriggers: [{ type: 'state_changed', entity: DOOR_ENTITY }],
});

// ---------- HA context helpers ----------

function makeHa(opts: {
  strongHoldEntities?: string[];
  doorEntities?: string[];
} = {}): Partial<HAContext> {
  const { strongHoldEntities = [], doorEntities = [] } = opts;
  const area = [MOTION_SENSOR, MOTION_GATE, PRESENCE_OVERRIDE, ...strongHoldEntities, ...doorEntities];
  return {
    entitiesByArea: (a) => (a === LOCATION ? area : []),
    entitiesByLabel: (label) => {
      if (label === 'presence_hold_strong') return strongHoldEntities;
      if (label === 'presence_hold_door') return doorEntities;
      return [];
    },
    labelsFor: () => [],
  };
}

const noHolds = makeHa();
const withStrongHold = makeHa({ strongHoldEntities: [PRESENCE_OVERRIDE] });
const withDoor = makeHa({ doorEntities: [DOOR_ENTITY] });

// ---------- Event helpers ----------

const stateChangedEvent = (entityId: string, from: string, to: string) => ({
  type: 'state_changed' as const,
  entity_id: entityId,
  old_state: { entity_id: entityId, state: from, attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entityId, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const motionEvent = (to: 'on' | 'off') => stateChangedEvent(MOTION_SENSOR, to === 'on' ? 'off' : 'on', to);
const motionGateEvent = (to: 'on' | 'off') => stateChangedEvent(MOTION_GATE, to === 'on' ? 'off' : 'on', to);
const presenceOverrideEvent = (to: 'on' | 'off') => stateChangedEvent(PRESENCE_OVERRIDE, to === 'on' ? 'off' : 'on', to);
const doorEvent = (to: 'on' | 'off') => stateChangedEvent(DOOR_ENTITY, to === 'on' ? 'off' : 'on', to);
const timerEvent = () => ({ type: 'timer_expired' as const, timerKey: TIMER_KEY, correlation_id: 'test-cid' });
const onStartEvent = () => ({ type: 'on_start' as const, correlation_id: 'test-cid' });

// ---------- State helpers ----------

const baseState = {
  [MOTION_SENSOR]: { state: 'off' },
  [MOTION_GATE]: { state: 'on' },
  [PRESENCE_OVERRIDE]: { state: 'off' },
  [`binary_sensor.${LOCATION}_occupied`]: { state: 'off' },
  [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'off' },
  [DOOR_ENTITY]: { state: 'off' }, // door closed
};

const occupiedState = { ...baseState, [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' } };

// ---------- Tests ----------

describe('makeOccupancyAutomation', () => {

  describe('room becomes occupied', () => {
    it('marks room occupied when motion is detected in an empty room', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'set_occupied', reason: 'motion_detected' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'ON', retain: true });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });

    it('cancels any pending clear timer when motion re-fires in an already-occupied room', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_detected' });
      expect(result.actions).not.toContainEqual(expect.objectContaining({ payload: 'ON' }));
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });

    it('marks room occupied when a presence hold activates in an empty room', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('on'),
        state: baseState,
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ decision: 'set_occupied', reason: 'strong_hold_active' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'ON', retain: true });
    });

    it('cancels any pending clear timer when a presence hold is active and room was already occupied', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('on'),
        state: occupiedState,
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'strong_hold_active' });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });

    it('attributes occupancy to the hold, not motion, when both are simultaneously active', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: { ...baseState, [PRESENCE_OVERRIDE]: { state: 'on' } },
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ reason: 'strong_hold_active' });
    });
  });

  describe('clear countdown starts when evidence clears', () => {
    it('starts the standard clear countdown when motion stops in an occupied room', () => {
      const result = testAutomation(automation, {
        event: motionEvent('off'),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 2 * 60_000 }));
    });

    it('starts the clear countdown on startup when room is already marked occupied', () => {
      const result = testAutomation(automation, {
        event: onStartEvent(),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
    });

    it('starts the clear countdown when a presence hold deactivates with no other evidence', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('off'),
        state: { ...occupiedState, [PRESENCE_OVERRIDE]: { state: 'on' } },
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY }));
    });

    it('keeps room occupied via motion when a presence hold deactivates but PIR is still active', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('off'),
        state: { ...occupiedState, [PRESENCE_OVERRIDE]: { state: 'on' }, [MOTION_SENSOR]: { state: 'on' } },
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ reason: 'motion_detected' });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });
  });

  describe('door opens — shortening the clear countdown', () => {
    it('shortens the countdown when a door opens with no other evidence (person may have just left)', () => {
      const result = testAutomation(automationWithDoor, {
        event: doorEvent('on'),
        state: { ...occupiedState, [DOOR_ENTITY]: { state: 'off' } },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'door_open_tighten_timer' });
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 1 * 60_000 }));
    });

    it('uses the standard countdown when PIR is still active as the door opens (person still present)', () => {
      // PIR on + gate on → evidence still present → standard clear timer, not door-tighten
      const result = testAutomation(automationWithDoor, {
        event: doorEvent('on'),
        state: { ...occupiedState, [MOTION_SENSOR]: { state: 'on' }, [DOOR_ENTITY]: { state: 'off' } },
        ha: withDoor,
      });
      expect(result).toMatchObject({ reason: 'motion_detected' });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });

    it('uses the standard countdown when the PIR sensor still reads motion (gate off) as the door opens', () => {
      // Gate off but sensor still shows motion — don't treat the stale PIR reading as evidence
      // that someone left, so use the full clear delay rather than the tightened one
      const result = testAutomation(automationWithDoor, {
        event: doorEvent('on'),
        state: { ...occupiedState, [MOTION_GATE]: { state: 'off' }, [MOTION_SENSOR]: { state: 'on' }, [DOOR_ENTITY]: { state: 'off' } },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      expect(result).not.toMatchObject({ reason: 'door_open_tighten_timer' });
    });
  });

  describe('room goes unoccupied when the clear timer fires', () => {
    it('marks room unoccupied when the clear timer expires', () => {
      const result = testAutomation(automation, {
        event: timerEvent(),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'clear_occupied', reason: 'timer_expired' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'OFF', retain: true });
    });

    it('does nothing if the timer fires when room is already unoccupied', () => {
      const result = testAutomation(automation, {
        event: timerEvent(),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'timer_expired' });
      expect(result.actions).not.toContainEqual(expect.objectContaining({ topic: `${LOCATION}/occupied/state`, payload: 'OFF' }));
    });

    it('marks room unoccupied and clears containment when the failsafe fires on a sealed room', () => {
      const result = testAutomation(automationWithDoor, {
        event: timerEvent(),
        state: {
          ...occupiedState,
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'clear_occupied', reason: 'containment_failsafe_expired' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'OFF', retain: true });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
    });
  });

  describe('containment — sealed room tracking', () => {
    it('marks room contained when motion fires with all doors closed', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('on'),
        state: { ...baseState, [DOOR_ENTITY]: { state: 'off' } },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'set_occupied' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'ON', retain: true });
    });

    it('does not mark contained when motion fires with a door open', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('on'),
        state: { ...baseState, [DOOR_ENTITY]: { state: 'on' } },
        ha: withDoor,
      });
      expect(result.actions).not.toContainEqual(expect.objectContaining({ topic: `${LOCATION}/occupied/contained/state` }));
    });

    it('waits for the long failsafe timeout when motion clears but room remains sealed', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('off'),
        state: {
          ...occupiedState,
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'contained_failsafe_wait' });
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 60 * 60_000 }));
    });

    it('drops containment and shortens the countdown when the door opens during containment', () => {
      const result = testAutomation(automationWithDoor, {
        event: doorEvent('on'),
        state: {
          ...occupiedState,
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'door_open_tighten_timer' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
      expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', delayMs: 1 * 60_000 }));
    });
  });

  describe('motion gate — disabling the PIR sensor', () => {
    it('ignores PIR completely and leaves the existing clear timer running when gate is off', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: { ...occupiedState, [MOTION_GATE]: { state: 'off' } },
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_disabled_ignore_pir' });
      expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.start' }));
      expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.cancel' }));
    });

    it('starts the clear countdown when the gate is turned off while room is occupied', () => {
      // Gate-off is not a PIR event so the ignore-PIR path does not apply;
      // with gate now off there is no evidence, so the normal clear timer starts
      const result = testAutomation(automation, {
        event: motionGateEvent('off'),
        state: { ...occupiedState, [MOTION_GATE]: { state: 'on' } },
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
    });

    it('drops containment when the gate is disabled while room is sealed and contained', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionGateEvent('off'),
        state: {
          ...occupiedState,
          [MOTION_GATE]: { state: 'on' },
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
    });

    it('drops containment but leaves timer untouched when PIR fires with gate off in a contained room', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('on'),
        state: {
          ...occupiedState,
          [MOTION_GATE]: { state: 'off' },
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_disabled_ignore_pir' });
      expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
      expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.start' }));
      expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.cancel' }));
    });
  });

  describe('room is already empty', () => {
    it('cancels any orphaned timer on startup when room is unoccupied', () => {
      const result = testAutomation(automation, {
        event: onStartEvent(),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'already_unoccupied' });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });

    it('cancels timer idempotently when a stale motion-off event arrives in an empty room', () => {
      const result = testAutomation(automation, {
        event: motionEvent('off'),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'already_unoccupied' });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
    });
  });

  describe('rooms without door hold configuration', () => {
    it('a door opening starts the standard countdown, not the tightened one, when no door holds are configured', () => {
      const result = testAutomation(automation, {
        event: doorEvent('on'),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      expect(result).not.toMatchObject({ reason: 'door_open_tighten_timer' });
    });
  });
});
