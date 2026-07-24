import { defineAutomation, requireState, requireNumericState, HomeAssistant } from '@ajclarkson/homerun';

const OVERTEMP_THRESHOLD_C = 25;

export default defineAutomation({
  id: 'foreign_office:overtemp_safety',
  location: 'foreign_office',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'sensor.foreign_office_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'switch.foreign_office_plug_heater' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const heaterState = requireState(state, 'switch.foreign_office_plug_heater');

    const temp = requireNumericState(state, 'sensor.foreign_office_sensor_climate_temperature');

    return {
      temp,
      heaterOn: heaterState === 'on',
    };
  },

  reduce: (ctx) => {
    const { temp, heaterOn } = ctx;

    if (temp > OVERTEMP_THRESHOLD_C && heaterOn) {
      return {
        decision: 'turn_off_heater',
        reason: 'overtemp_heater_on',
        actions: [
          HomeAssistant.switch.turn_off({ entity_id: 'switch.foreign_office_plug_heater' }),
        ],
      };
    }

    return {
      decision: 'no_action',
      reason: temp > OVERTEMP_THRESHOLD_C ? 'overtemp_heater_already_off' : 'temp_normal',
      actions: [],
    };
  },
});
