import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:sleep_mode_button',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' },
  ],

  context: (state) => {
    const bedOccupied = state('binary_sensor.bedroom_sensor_bed_occupancy')?.state;
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
      inputs: { bedOccupied, houseMode, parlourActive },
    };
  },

  reduce: (ctx) => {
    if (!ctx.bedOccupied) {
      return { decision: 'no_action', reason: 'bed_not_occupied', inputs: ctx.inputs, actions: [] };
    }
    if (ctx.parlourActive) {
      return { decision: 'no_action', reason: 'parlour_active', inputs: ctx.inputs, actions: [] };
    }
    if (ctx.houseMode === 'sleep') {
      return { decision: 'no_action', reason: 'already_in_sleep_mode', inputs: ctx.inputs, actions: [] };
    }
    return {
      decision: 'set_sleep',
      reason: 'button_hold_bed_occupied',
      inputs: ctx.inputs,
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep' },
      ],
    };
  },
});
