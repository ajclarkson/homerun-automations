import { defineAutomation, abort } from '@ajclarkson/homerun';
import { Services } from '../types/ha-services.js';

export default defineAutomation({
  id: 'house:camera_mode_sync',
  location: 'house',
  subsystem: 'cameras',

  triggers: [
    { type: 'state_changed', entity: 'sensor.house_active_mode' },
    { type: 'state_changed', entity: 'input_select.house_active_mode_modifier' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    const modifier = state('input_select.house_active_mode_modifier')?.state;
    if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
      return abort(`modifier_unavailable:${modifier}`);
    }

    return {
      houseMode,
      guestPresent: modifier === 'guest',
      inputs: { houseMode, modifier },
    };
  },

  reduce: (ctx) => {
    const { houseMode, guestPresent } = ctx;

    if (houseMode === 'away' && !guestPresent) {
      return {
        decision: 'cameras_on',
        reason: 'house_away',
        inputs: ctx.inputs,
        actions: [
          Services.switch.turn_off({ entity_id: 'group.cameras_privacy' }),
        ],
      };
    }

    if (houseMode === 'away' && guestPresent) {
      return {
        decision: 'no_action',
        reason: 'away_but_guest_present',
        inputs: ctx.inputs,
        actions: [],
      };
    }

    if (houseMode === 'sleep') {
      return {
        decision: 'sleep_mo_monitoring',
        reason: 'sleep_kitchen_camera_on',
        inputs: ctx.inputs,
        actions: [
          Services.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
          Services.switch.turn_off({ entity_id: 'switch.kitchen_privacy' }),
        ],
      };
    }

    if (houseMode === 'normal') {
      return {
        decision: 'cameras_off',
        reason: 'house_not_away',
        inputs: ctx.inputs,
        actions: [
          Services.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
        ],
      };
    }

    return {
      decision: 'no_action',
      reason: `mode_not_managed:${houseMode}`,
      inputs: ctx.inputs,
      actions: [],
    };
  },
});
