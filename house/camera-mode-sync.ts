import { defineAutomation, abort, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';

// Cameras going on or off with the house mode is `acted`. A guest keeping cameras off while the
// house is away is `declined`; a mode this does not manage is bookkeeping.
// The `_startup` twins are the same actions on a homerun restart, which only re-asserts the current
// mode, so they are `ignored`.
export const CAMERA_MODE_SYNC_REASONS = {
  house_away: { outcome: 'acted' },
  sleep_kitchen_camera_on: { outcome: 'acted' },
  house_not_away: { outcome: 'acted' },
  house_away_startup: { outcome: 'ignored' },
  sleep_kitchen_camera_on_startup: { outcome: 'ignored' },
  house_not_away_startup: { outcome: 'ignored' },
  away_but_guest_present: { outcome: 'declined' },
  mode_not_managed: { outcome: 'ignored', facts: ['mode'] },
} as const;

type CameraModeDecision = DeclaredDecision<typeof CAMERA_MODE_SYNC_REASONS>;

export default defineAutomation({
  reasons: CAMERA_MODE_SYNC_REASONS,
  id: 'house:camera_mode_sync',
  location: 'house',
  subsystem: 'cameras',

  triggers: [
    { type: 'state_changed', entity: 'sensor.house_active_mode' },
    { type: 'state_changed', entity: 'input_select.house_active_mode_modifier' },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => {
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
      modifier,
      startup: event.type === 'on_start',
    };
  },

  reduce: (ctx): CameraModeDecision => {
    const { houseMode, guestPresent, startup } = ctx;
    const sfx = startup ? '_startup' as const : '' as const;

    if (houseMode === 'away' && !guestPresent) {
      return {
        decision: 'cameras_on',
        reason: `house_away${sfx}`,
        actions: [
          HomeAssistant.switch.turn_off({ entity_id: 'group.cameras_privacy' }),
        ],
      };
    }

    if (houseMode === 'away' && guestPresent) {
      return {
        decision: 'no_action',
        reason: 'away_but_guest_present',
        actions: [],
      };
    }

    if (houseMode === 'sleep') {
      return {
        decision: 'sleep_mo_monitoring',
        reason: `sleep_kitchen_camera_on${sfx}`,
        actions: [
          HomeAssistant.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
          HomeAssistant.switch.turn_off({ entity_id: 'switch.kitchen_privacy' }),
        ],
      };
    }

    if (houseMode === 'normal') {
      return {
        decision: 'cameras_off',
        reason: `house_not_away${sfx}`,
        actions: [
          HomeAssistant.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
        ],
      };
    }

    return {
      decision: 'no_action',
      reason: 'mode_not_managed',
      facts: { mode: houseMode },
      actions: [],
    };
  },
});
