import { defineAutomation, abort } from '@ajclarkson/homerun';

const OVERTEMP_THRESHOLD_C = 25;

export default defineAutomation({
  id: 'foreign-office:overtemp-safety',
  location: 'foreign-office',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'sensor.foreign_office_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'switch.foreign_office_plug_heater' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const heaterState = state('switch.foreign_office_plug_heater')?.state;
    if (!heaterState || heaterState === 'unavailable' || heaterState === 'unknown') {
      return abort(`heater_unavailable:${heaterState}`);
    }

    // No heater running means no safety risk — nothing to evaluate.
    if (heaterState !== 'on') {
      return abort('heater_off');
    }

    const tempStr = state('sensor.foreign_office_sensor_climate_temperature')?.state;
    const temp = parseFloat(tempStr ?? '');
    if (!Number.isFinite(temp)) {
      return abort(`temp_unavailable:${tempStr}`);
    }

    return {
      temp,
      inputs: { temp, heaterState },
    };
  },

  reduce: (ctx) => {
    const { temp } = ctx;

    if (temp > OVERTEMP_THRESHOLD_C) {
      return {
        decision: 'turn_off_heater',
        reason: 'overtemp_heater_on',
        inputs: ctx.inputs,
        actions: [
          {
            type: 'ha.call_service',
            domain: 'switch',
            service: 'turn_off',
            target: { entity_id: 'switch.foreign_office_plug_heater' },
          },
        ],
      };
    }

    return {
      decision: 'no_action',
      reason: 'temp_normal',
      inputs: ctx.inputs,
      actions: [],
    };
  },
});
