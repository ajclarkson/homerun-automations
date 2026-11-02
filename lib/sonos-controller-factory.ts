import { defineAutomation, type Action, type DeclaredDecision } from '@ajclarkson/homerun';

export interface SonosRoomConfig {
  location: string;
  masterPlayer?: string;
}

// Following the room's occupancy is routine grouping, so it is `ignored`; only a person flipping
// the automation toggle is `acted`. `automation_disabled` is the toggle turning it off (the unjoin);
// `automation_disabled_idle` is occupancy changing while it is already off.
export const SONOS_REASONS = {
  automation_enabled: { outcome: 'acted' },
  automation_disabled: { outcome: 'acted' },
  occupancy_on: { outcome: 'ignored' },
  occupancy_off: { outcome: 'ignored' },
  automation_disabled_idle: { outcome: 'ignored' },
  automation_toggle_unknown_state: { outcome: 'ignored' },
  occupancy_unknown_state: { outcome: 'ignored' },
  unclassified_trigger: { outcome: 'ignored' },
} as const;

type SonosDecision = DeclaredDecision<typeof SONOS_REASONS>;

type SonosTrigger = 'occupancy' | 'automation_toggle' | 'system';

interface SonosContext {
  location: string;
  trigger: SonosTrigger;
  triggerTo: string;
  automationEnabled: boolean;
  mediaPlayerEntity: string;
  masterPlayer: string;
}

export function makeSonosAutomation(config: SonosRoomConfig) {
  const { location, masterPlayer = 'media_player.parlour' } = config;

  const occupiedSensor = `binary_sensor.${location}_occupied`;
  const automationToggle = `input_boolean.${location}_automation_sonos_enabled`;
  const mediaPlayerEntity = `media_player.${location}`;

  return defineAutomation<SonosContext, typeof SONOS_REASONS>({
    reasons: SONOS_REASONS,
    id: `${location}:sonos`,
    location,
    subsystem: 'sonos',

    triggers: [
      { type: 'state_changed', entity: occupiedSensor as keyof HAEntities },
      { type: 'state_changed', entity: automationToggle as keyof HAEntities },
    ],

    context: (state, _ha, event) => {
      const automationEnabled = state(automationToggle as keyof HAEntities)?.state === 'on';

      let trigger: SonosTrigger = 'system';
      let triggerTo = '';

      if (event.type === 'state_changed') {
        triggerTo = event.new_state.state;
        if (event.entity_id === occupiedSensor) {
          trigger = 'occupancy';
        } else if (event.entity_id === automationToggle) {
          trigger = 'automation_toggle';
        }
      }

      return {
        location,
        trigger,
        triggerTo,
        automationEnabled,
        mediaPlayerEntity,
        masterPlayer,
      };
    },

    reduce: (ctx): SonosDecision => {
      const { trigger, triggerTo, automationEnabled, mediaPlayerEntity, masterPlayer } = ctx;

      const joinAction = (): Action => ({
        type: 'ha.call_service',
        domain: 'media_player',
        service: 'join',
        target: { entity_id: masterPlayer },
        data: { group_members: [mediaPlayerEntity] },
      });

      const unjoinAction = (): Action => ({
        type: 'ha.call_service',
        domain: 'media_player',
        service: 'unjoin',
        target: { entity_id: mediaPlayerEntity },
      });

      if (trigger === 'automation_toggle') {
        if (triggerTo === 'on') {
          return { decision: 'join', reason: 'automation_enabled', actions: [joinAction()] };
        }
        if (triggerTo === 'off') {
          return { decision: 'unjoin', reason: 'automation_disabled', actions: [unjoinAction()] };
        }
        return { decision: 'no_action', reason: 'automation_toggle_unknown_state', actions: [] };
      }

      if (!automationEnabled) {
        return { decision: 'no_action', reason: 'automation_disabled_idle', actions: [] };
      }

      if (trigger === 'occupancy') {
        if (triggerTo === 'on') {
          return { decision: 'join', reason: 'occupancy_on', actions: [joinAction()] };
        }
        if (triggerTo === 'off') {
          return { decision: 'unjoin', reason: 'occupancy_off', actions: [unjoinAction()] };
        }
        return { decision: 'no_action', reason: 'occupancy_unknown_state', actions: [] };
      }

      return { decision: 'no_action', reason: 'unclassified_trigger', actions: [] };
    },
  });
}
