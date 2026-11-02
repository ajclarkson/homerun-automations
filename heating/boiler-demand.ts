import { defineAutomation, abort, type DeclaredDecision } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

// The boiler call starting or stopping is what a person notices. The rooms are one comma-joined
// fact so the reason stays static.
export const BOILER_DEMAND_REASONS = {
  demand: { outcome: 'acted', facts: ['rooms'] },
  no_demand: { outcome: 'acted' },
  heating_disabled: { outcome: 'acted' },
} as const;

type BoilerDecision = DeclaredDecision<typeof BOILER_DEMAND_REASONS>;

export default defineAutomation({
  reasons: BOILER_DEMAND_REASONS,
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

  reduce: (ctx): BoilerDecision => {
    const { heatingEnabled, callingRooms, demand } = ctx;

    const actions = (setpoint: number) => [{
      type: 'mqtt.publish' as const,
      topic: 'zigbee2mqtt/boiler_receiver/set',
      payload: JSON.stringify({
        system_mode_heat: 'heat',
        temperature_setpoint_hold_heat: 1,
        occupied_heating_setpoint_heat: setpoint,
      }),
      retain: false,
    }];

    if (!heatingEnabled) {
      return { decision: 'boiler_off', reason: 'heating_disabled', actions: actions(5) };
    }
    if (demand) {
      return { decision: 'boiler_on', reason: 'demand', facts: { rooms: callingRooms.join(',') }, actions: actions(30) };
    }
    return { decision: 'boiler_off', reason: 'no_demand', actions: actions(5) };
  },
});
