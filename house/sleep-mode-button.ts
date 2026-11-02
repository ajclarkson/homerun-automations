import { defineAutomation, abort } from '@ajclarkson/homerun';

// Putting the house to sleep is `acted`. A hold that is refused (nobody in bed, the parlour in
// use) is `declined`, because the person holding the button expects sleep mode.
export const SLEEP_MODE_BUTTON_REASONS = {
  button_hold_bed_occupied: { outcome: 'acted' },
  bed_not_occupied: { outcome: 'declined' },
  parlour_active: { outcome: 'declined' },
  already_in_sleep_mode: { outcome: 'ignored' },
} as const;

export default defineAutomation({
  reasons: SLEEP_MODE_BUTTON_REASONS,
  id: 'house:sleep_mode_button',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' },
  ],

  context: (state) => {
    const bedOccupied = state('binary_sensor.bedroom_bed_occupied')?.state;
    if (!bedOccupied || bedOccupied === 'unavailable' || bedOccupied === 'unknown') {
      return abort(`bed_sensor_unavailable:${bedOccupied}`);
    }

    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    const parlourActive = state('binary_sensor.parlour_media_active')?.state === 'on';

    return {
      bedOccupied: bedOccupied === 'on',
      houseMode,
      parlourActive,
    };
  },

  reduce: (ctx) => {
    if (!ctx.bedOccupied) {
      return { decision: 'no_action', reason: 'bed_not_occupied', actions: [] };
    }
    if (ctx.parlourActive) {
      return { decision: 'no_action', reason: 'parlour_active', actions: [] };
    }
    if (ctx.houseMode === 'sleep') {
      return { decision: 'no_action', reason: 'already_in_sleep_mode', actions: [] };
    }
    return {
      decision: 'set_sleep',
      reason: 'button_hold_bed_occupied',
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep', impliesEntity: 'sensor.house_active_mode' },
      ],
    };
  },
});
