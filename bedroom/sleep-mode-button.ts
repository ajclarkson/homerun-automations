import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'bedroom:sleep_mode_button',
  location: 'bedroom',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: 'sensor.bedroom_button_adam_action', gesture: 'hold' },
    { type: 'button', entity: 'sensor.bedroom_button_wall_action', gesture: 'hold' },
  ],

  context: (state) => {
    const bedOccupied = state('binary_sensor.bedroom_sensor_bed_occupancy')?.state;
    if (bedOccupied !== 'on') {
      return abort(`bed_not_occupied:${bedOccupied}`);
    }

    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    if (houseMode === 'sleep') {
      return abort('already_in_sleep_mode');
    }

    return {
      houseMode,
      inputs: { bedOccupied, houseMode },
    };
  },

  reduce: (ctx) => ({
    decision: 'set_sleep',
    reason: 'button_hold_bed_occupied',
    inputs: ctx.inputs,
    actions: [
      { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep' },
    ],
  }),
});
