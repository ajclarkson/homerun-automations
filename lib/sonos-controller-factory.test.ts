import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import { makeSonosAutomation } from './sonos-controller-factory.js';

const LOCATION = 'test_room';
const OCCUPIED_SENSOR = `binary_sensor.${LOCATION}_occupied`;
const AUTOMATION_TOGGLE = `input_boolean.${LOCATION}_automation_sonos_enabled`;
const MEDIA_PLAYER = `media_player.${LOCATION}`;
const MASTER_PLAYER = 'media_player.parlour';

const automation = makeSonosAutomation({ location: LOCATION });

const ha = { entitiesByLabel: () => [], entitiesByArea: () => [], labelsFor: () => [] };

function stateChangedEvent(entityId: string, to: string) {
  return {
    type: 'state_changed' as const,
    entity_id: entityId,
    old_state: { entity_id: entityId, state: to === 'on' ? 'off' : 'on', attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: entityId, state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

const enabledState = {
  [OCCUPIED_SENSOR]: { state: 'off' },
  [AUTOMATION_TOGGLE]: { state: 'on' },
};

const disabledState = {
  [OCCUPIED_SENSOR]: { state: 'off' },
  [AUTOMATION_TOGGLE]: { state: 'off' },
};

function joinAction() {
  return {
    type: 'ha.call_service',
    domain: 'media_player',
    service: 'join',
    target: { entity_id: MASTER_PLAYER },
    data: { group_members: [MEDIA_PLAYER] },
  };
}

function unjoinAction() {
  return {
    type: 'ha.call_service',
    domain: 'media_player',
    service: 'unjoin',
    target: { entity_id: MEDIA_PLAYER },
  };
}

describe('makeSonosAutomation', () => {

  describe('occupancy trigger — automation enabled', () => {
    it('joins the master group when the room becomes occupied', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(OCCUPIED_SENSOR, 'on'),
        state: enabledState,
        ha,
      });
      expect(result).toMatchObject({ decision: 'join', reason: 'occupancy_on' });
      expect(result.actions).toEqual([joinAction()]);
    });

    it('unjoins when the room becomes unoccupied', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(OCCUPIED_SENSOR, 'off'),
        state: enabledState,
        ha,
      });
      expect(result).toMatchObject({ decision: 'unjoin', reason: 'occupancy_off' });
      expect(result.actions).toEqual([unjoinAction()]);
    });
  });

  describe('occupancy trigger — automation disabled', () => {
    it('takes no action when occupancy fires but automation is disabled', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(OCCUPIED_SENSOR, 'on'),
        state: disabledState,
        ha,
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([]);
    });

    it('takes no action when room empties but automation is disabled', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(OCCUPIED_SENSOR, 'off'),
        state: disabledState,
        ha,
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('automation toggle trigger', () => {
    it('joins the master group immediately when the automation is turned on', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(AUTOMATION_TOGGLE, 'on'),
        state: enabledState,
        ha,
      });
      expect(result).toMatchObject({ decision: 'join', reason: 'automation_enabled' });
      expect(result.actions).toEqual([joinAction()]);
    });

    it('unjoins immediately when the automation is turned off, even if room is occupied', () => {
      const result = testAutomation(automation, {
        event: stateChangedEvent(AUTOMATION_TOGGLE, 'off'),
        state: { ...disabledState, [OCCUPIED_SENSOR]: { state: 'on' } },
        ha,
      });
      expect(result).toMatchObject({ decision: 'unjoin', reason: 'automation_disabled' });
      expect(result.actions).toEqual([unjoinAction()]);
    });
  });

  describe('custom master player', () => {
    it('uses the configured master player instead of the default', () => {
      const customMaster = 'media_player.bedroom';
      const automationWithCustomMaster = makeSonosAutomation({ location: LOCATION, masterPlayer: customMaster });
      const result = testAutomation(automationWithCustomMaster, {
        event: stateChangedEvent(OCCUPIED_SENSOR, 'on'),
        state: enabledState,
        ha,
      });
      expect(result.actions).toEqual([{
        type: 'ha.call_service',
        domain: 'media_player',
        service: 'join',
        target: { entity_id: customMaster },
        data: { group_members: [MEDIA_PLAYER] },
      }]);
    });
  });

});
