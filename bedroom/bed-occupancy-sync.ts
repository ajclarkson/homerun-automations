import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'bedroom:bed-occupancy-sync',
  location: 'bedroom',
  subsystem: 'occupancy',

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
      {
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: ctx.occupied ? 'turn_on' : 'turn_off',
        target: { entity_id: 'input_boolean.hallway_upstairs_bed_occupied_sync' },
      },
    ],
  }),
});
