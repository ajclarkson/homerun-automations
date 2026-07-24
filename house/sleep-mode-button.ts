import { defineAutomation, requireState } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:sleep_mode_button',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' },
  ],

  context: (state) => {
    const bedOccupied = requireState(state, 'binary_sensor.bedroom_bed_occupied');

    const houseMode = requireState(state, 'sensor.house_active_mode');

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
