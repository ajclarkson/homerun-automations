import { defineAutomation, abort } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

export default defineAutomation({
  id: 'house:boiler_demand',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: /^binary_sensor\..+_trv_heat_required$/ },
    { type: 'state_changed', entity: 'input_boolean.house_heating_enabled' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const heatingEnabledState = state('input_boolean.house_heating_enabled')?.state;
    if (!heatingEnabledState || heatingEnabledState === 'unavailable' || heatingEnabledState === 'unknown') {
      return abort(`heating_enabled_unavailable:${heatingEnabledState}`);
    }

    const heatingEnabled = heatingEnabledState === 'on';
    const callingRooms = HEATING_ROOMS.filter(
      room => state(`binary_sensor.${room}_trv_heat_required` as keyof HAEntities)?.state === 'on'
    );
    const demand = callingRooms.length > 0;

    return {
      heatingEnabled,
      callingRooms,
      demand,
    };
  },

  reduce: (ctx) => {
    const { heatingEnabled, callingRooms, demand } = ctx;

    let decision = 'uninitialised';
    let reason = 'uninitialised';
    let setpoint = 5;

    if (!heatingEnabled) {
      decision = 'boiler_off';
      reason = 'heating_disabled';
      setpoint = 5;
    } else if (demand) {
      decision = 'boiler_on';
      reason = `demand:${callingRooms.join(',')}`;
      setpoint = 30;
    } else {
      decision = 'boiler_off';
      reason = 'no_demand';
      setpoint = 5;
    }

    return {
      decision,
      reason,
      actions: [{
        type: 'mqtt.publish',
        topic: 'zigbee2mqtt/boiler_receiver/set',
        payload: JSON.stringify({
          system_mode_heat: 'heat',
          temperature_setpoint_hold_heat: 1,
          occupied_heating_setpoint_heat: setpoint,
        }),
        retain: false,
      }],
    };
  },
});
