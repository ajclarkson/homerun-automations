import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:patio_door',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.parlour_sensor_door_patio_contact' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const doorState = state('binary_sensor.parlour_sensor_door_patio_contact')?.state;
    if (!doorState || doorState === 'unavailable' || doorState === 'unknown') {
      return abort(`door_unavailable:${doorState}`);
    }

    const heatingEnabledState = state('input_boolean.house_heating_enabled')?.state;
    if (!heatingEnabledState || heatingEnabledState === 'unavailable' || heatingEnabledState === 'unknown') {
      return abort(`heating_enabled_unavailable:${heatingEnabledState}`);
    }

    const suspendedState = state('input_boolean.patio_door_heating_suspended')?.state;
    if (!suspendedState || suspendedState === 'unavailable' || suspendedState === 'unknown') {
      return abort(`suspended_flag_unavailable:${suspendedState}`);
    }

    const doorOpen  = doorState === 'on';
    const heatingOn = heatingEnabledState === 'on';
    const suspended = suspendedState === 'on';

    return { doorOpen, heatingOn, suspended, inputs: { doorOpen, heatingOn, suspended } };
  },

  reduce: (ctx) => {
    const { doorOpen, heatingOn, suspended } = ctx;

    if (doorOpen && heatingOn) {
      return {
        decision: 'suspend',
        reason: 'door_open_heating_on',
        inputs: ctx.inputs,
        // Flag written before heating off — crash-safe: on_start re-applies suspend if flag is set
        actions: [
          HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.patio_door_heating_suspended' }),
          HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.house_heating_enabled' }),
        ],
      };
    }

    if (!doorOpen && suspended) {
      return {
        decision: 'restore',
        reason: 'door_closed_was_suspended',
        inputs: ctx.inputs,
        // Heating restored before flag cleared — crash-safe: on_start restores again if both true (idempotent)
        actions: [
          HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.house_heating_enabled' }),
          HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.patio_door_heating_suspended' }),
        ],
      };
    }

    const reason = doorOpen && !heatingOn && !suspended
      ? 'door_open_heating_already_off'
      : 'door_closed_not_suspended';

    return { decision: 'no_action', reason, inputs: ctx.inputs, actions: [] };
  },
});
