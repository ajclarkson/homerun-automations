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

  describe('Branch 0 — PIR fired while motion gate is off', () => {
    it('returns no_change and does not touch the timer', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: { ...baseState, [MOTION_GATE]: { state: 'off' } },
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_disabled_ignore_pir' });
      if (!('abort' in result)) {
        expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.start' }));
        expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.cancel' }));
      }
    });

    it('publishes contained OFF when PIR fires with gate already off and room is contained', () => {
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
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
      }
    });
  });

  describe('Branch 1 — Evidence present (motion or strong hold)', () => {
    describe('motion detected', () => {
      it('publishes occupied ON and cancels timer when previously unoccupied', () => {
        const result = testAutomation(automation, {
          event: motionEvent('on'),
          state: baseState,
          ha: noHolds,
        });
        expect(result).toMatchObject({ decision: 'set_occupied', reason: 'motion_detected' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'ON', retain: true });
          expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
        }
      });

      it('returns no_change and cancels timer when already occupied', () => {
        const result = testAutomation(automation, {
          event: motionEvent('on'),
          state: occupiedState,
          ha: noHolds,
        });
        expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_detected' });
        if (!('abort' in result)) {
          expect(result.actions).not.toContainEqual(expect.objectContaining({ payload: 'ON' }));
          expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
        }
      });
    });

    describe('strong hold', () => {
      it('publishes occupied ON when strong hold entity turns on and room was unoccupied', () => {
        const result = testAutomation(automation, {
          event: presenceOverrideEvent('on'),
          state: baseState,
          ha: withStrongHold,
        });
        expect(result).toMatchObject({ decision: 'set_occupied', reason: 'strong_hold_active' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'ON', retain: true });
        }
      });

      it('cancels timer when strong hold entity turns on and room was already occupied', () => {
        const result = testAutomation(automation, {
          event: presenceOverrideEvent('on'),
          state: occupiedState,
          ha: withStrongHold,
        });
        expect(result).toMatchObject({ decision: 'no_change', reason: 'strong_hold_active' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
        }
      });

      it('takes strong_hold_active reason over motion_detected when both are active', () => {
        const result = testAutomation(automation, {
          event: motionEvent('on'),
          state: { ...baseState, [PRESENCE_OVERRIDE]: { state: 'on' } },
          ha: withStrongHold,
        });
        expect(result).toMatchObject({ reason: 'strong_hold_active' });
      });
    });
  });

  describe('Branch 2 — Timer expired', () => {
    it('publishes occupied OFF when room was occupied', () => {
      const result = testAutomation(automation, {
        event: timerEvent(),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'clear_occupied', reason: 'timer_expired' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'OFF', retain: true });
      }
    });

    it('returns no_change when timer fires but room was already unoccupied', () => {
      const result = testAutomation(automation, {
        event: timerEvent(),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'timer_expired' });
      if (!('abort' in result)) {
        expect(result.actions).not.toContainEqual(expect.objectContaining({ payload: 'OFF', topic: `${LOCATION}/occupied/state` }));
      }
    });

    it('uses containment_failsafe_expired reason and clears both topics when was contained', () => {
      const result = testAutomation(automationWithDoor, {
        event: timerEvent(),
        state: {
          ...occupiedState,
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' }, // sealed
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'clear_occupied', reason: 'containment_failsafe_expired' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/state`, payload: 'OFF', retain: true });
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
      }
    });
  });

  describe('Branch 3 — No evidence, room occupied', () => {
    it('starts normal clear timer when motion clears', () => {
      const result = testAutomation(automation, {
        event: motionEvent('off'),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 2 * 60_000 }));
      }
    });

    it('starts normal clear timer on on_start when room is already occupied', () => {
      const result = testAutomation(automation, {
        event: onStartEvent(),
        state: occupiedState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
    });

    describe('door opens (with containment config)', () => {
      it('starts tightened clear timer when door opens and no other evidence', () => {
        const result = testAutomation(automationWithDoor, {
          event: doorEvent('on'),
          state: {
            ...occupiedState,
            [DOOR_ENTITY]: { state: 'off' }, // was closed, opening now
          },
          ha: withDoor,
        });
        expect(result).toMatchObject({ decision: 'no_change', reason: 'door_open_tighten_timer' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 1 * 60_000 }));
        }
      });

      it('starts normal clear timer (not tightened) when door opens but PIR is still active', () => {
        const result = testAutomation(automationWithDoor, {
          event: doorEvent('on'),
          state: {
            ...occupiedState,
            [MOTION_SENSOR]: { state: 'on' },
            [DOOR_ENTITY]: { state: 'off' },
          },
          ha: withDoor,
        });
        // PIR is on → evidenceNow=true → Branch 1, not Branch 3
        expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_detected' });
      });
    });

    describe('containment failsafe', () => {
      it('starts containment max timer when room is contained and sealed', () => {
        const result = testAutomation(automationWithDoor, {
          event: motionEvent('off'),
          state: {
            ...occupiedState,
            [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
            [DOOR_ENTITY]: { state: 'off' }, // sealed
          },
          ha: withDoor,
        });
        expect(result).toMatchObject({ decision: 'no_change', reason: 'contained_failsafe_wait' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 60 * 60_000 }));
        }
      });

      it('starts normal timer (not containment) when door opens breaking the seal', () => {
        const result = testAutomation(automationWithDoor, {
          event: doorEvent('on'),
          state: {
            ...occupiedState,
            [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
            [DOOR_ENTITY]: { state: 'off' }, // was sealed, now opening
          },
          ha: withDoor,
        });
        // isDoorMsg=true, sealedNow=false after door opens → containedNext=false
        // door_open_tighten_timer fires (door opened, no PIR, no strong hold)
        expect(result).toMatchObject({ decision: 'no_change', reason: 'door_open_tighten_timer' });
        if (!('abort' in result)) {
          expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
        }
      });
    });
  });

  describe('Branch 4 — No evidence, room unoccupied', () => {
    it('cancels timer on on_start when room is unoccupied', () => {
      const result = testAutomation(automation, {
        event: onStartEvent(),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'already_unoccupied' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
      }
    });

    it('cancels timer when motion clears in an already-unoccupied room', () => {
      const result = testAutomation(automation, {
        event: motionEvent('off'),
        state: baseState,
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'already_unoccupied' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
      }
    });
  });

  describe('containment transitions', () => {
    it('publishes contained ON when PIR fires while door is sealed', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('on'),
        state: {
          ...baseState,
          [DOOR_ENTITY]: { state: 'off' }, // sealed
        },
        ha: withDoor,
      });
      expect(result).toMatchObject({ decision: 'set_occupied' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'ON', retain: true });
      }
    });

    it('does not publish contained ON when PIR fires with door open', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionEvent('on'),
        state: {
          ...baseState,
          [DOOR_ENTITY]: { state: 'on' }, // open
        },
        ha: withDoor,
      });
      if (!('abort' in result)) {
        expect(result.actions).not.toContainEqual(expect.objectContaining({ topic: `${LOCATION}/occupied/contained/state` }));
      }
    });

    it('publishes contained OFF when motion gate is disabled while room is contained', () => {
      const result = testAutomation(automationWithDoor, {
        event: motionGateEvent('off'),
        state: {
          ...occupiedState,
          [MOTION_GATE]: { state: 'on' }, // was on
          [`binary_sensor.${LOCATION}_occupied_contained`]: { state: 'on' },
          [DOOR_ENTITY]: { state: 'off' },
        },
        ha: withDoor,
      });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'mqtt.publish', topic: `${LOCATION}/occupied/contained/state`, payload: 'OFF', retain: true });
      }
    });
  });

  describe('motion gate disabled', () => {
    it('starts normal clear timer when gate turns off while occupied (not PIR-triggered)', () => {
      const result = testAutomation(automation, {
        event: motionGateEvent('off'),
        state: {
          ...occupiedState,
          [MOTION_GATE]: { state: 'on' }, // was on
        },
        ha: noHolds,
      });
      // motionGateEvent is NOT a PIR trigger, so Branch 0 doesn't apply
      // motionEnabled is now false (from event), pirRaw=false → evidenceNow=false
      // occupied → normal_clear_timer
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
    });

    it('does not touch timer when PIR fires with gate off (Branch 0)', () => {
      const result = testAutomation(automation, {
        event: motionEvent('on'),
        state: { ...occupiedState, [MOTION_GATE]: { state: 'off' } },
        ha: noHolds,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'motion_disabled_ignore_pir' });
      if (!('abort' in result)) {
        expect(result.actions).not.toContainEqual(expect.objectContaining({ type: 'timer.start' }));
      }
    });
  });

  describe('strong hold turns off', () => {
    it('starts clear timer when strong hold releases and no other evidence', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('off'),
        state: {
          ...occupiedState,
          [PRESENCE_OVERRIDE]: { state: 'on' }, // was on, now turning off
        },
        ha: withStrongHold,
      });
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual(expect.objectContaining({ type: 'timer.start', timerKey: TIMER_KEY }));
      }
    });

    it('sets occupied if PIR is still active when strong hold releases', () => {
      const result = testAutomation(automation, {
        event: presenceOverrideEvent('off'),
        state: {
          ...occupiedState,
          [PRESENCE_OVERRIDE]: { state: 'on' },
          [MOTION_SENSOR]: { state: 'on' },
        },
        ha: withStrongHold,
      });
      // PIR still on → evidenceNow=true → Branch 1
      expect(result).toMatchObject({ reason: 'motion_detected' });
      if (!('abort' in result)) {
        expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: TIMER_KEY });
      }
    });
  });

  describe('door contact trigger not in defaults', () => {
    it('does not restart timer when front door opens on automation without extraTriggers', () => {
      // This tests that the base automation is not affected by door events from the
      // perspective of the reducer — even if the engine somehow dispatched one,
      // isDoorMsg would be false (no presence_hold_door entities), so it falls to
      // normal_clear_timer rather than door_open_tighten_timer.
      const result = testAutomation(automation, {
        event: doorEvent('on'),
        state: occupiedState,
        ha: noHolds, // no door entities configured
      });
      // isDoorMsg=false → does NOT take the tighten branch
      expect(result).toMatchObject({ decision: 'no_change', reason: 'normal_clear_timer' });
      expect(result).not.toMatchObject({ reason: 'door_open_tighten_timer' });
    });
  });
});
