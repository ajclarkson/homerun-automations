import { defineAutomation, abort } from '@ajclarkson/homerun';

const OVERTEMP_THRESHOLD_C = 25;

export default defineAutomation({
  id: 'foreign_office:overtemp-safety',
  location: 'foreign_office',
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

    const tempStr = state('sensor.foreign_office_sensor_climate_temperature')?.state;
    const temp = parseFloat(tempStr ?? '');
    if (!Number.isFinite(temp)) {
      return abort(`temp_unavailable:${tempStr}`);
    }

    return {
      temp,
      heaterOn: heaterState === 'on',
      inputs: { temp, heaterState },
    };
  },

  reduce: (ctx) => {
    const { temp, heaterOn } = ctx;

    if (temp > OVERTEMP_THRESHOLD_C && heaterOn) {
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
      reason: temp > OVERTEMP_THRESHOLD_C ? 'overtemp_heater_already_off' : 'temp_normal',
      inputs: ctx.inputs,
      actions: [],
    };
  },
});
