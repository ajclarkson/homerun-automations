import { defineAutomation, abort } from '@ajclarkson/homerun';
import { Services } from '../types/ha-services.js';

export default defineAutomation({
  id: 'bedroom:bed_occupancy_sync',
  location: 'bedroom',
  subsystem: 'hold_sync',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.bedroom_sensor_bed_occupancy' },
  ],

  context: (state) => {
    const bedState = state('binary_sensor.bedroom_sensor_bed_occupancy')?.state;

    if (bedState === 'unavailable' || bedState === 'unknown' || bedState == null) {
      return abort(`bed_sensor_unavailable:${bedState}`);
    }

    return {
      occupied: bedState === 'on',
      inputs: { bedState },
    };
  },

  reduce: (ctx) => ({
    decision: ctx.occupied ? 'occupied' : 'unoccupied',
    reason: 'bed_sensor_state_changed',
    inputs: ctx.inputs,
    actions: [
      ctx.occupied
        ? Services.input_boolean.turn_on({ entity_id: 'input_boolean.hallway_upstairs_bed_occupied_sync' })
        : Services.input_boolean.turn_off({ entity_id: 'input_boolean.hallway_upstairs_bed_occupied_sync' }),
    ],
  }),
});
