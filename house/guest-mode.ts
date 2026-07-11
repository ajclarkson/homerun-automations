import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:guest-mode',
  location: 'house',
  subsystem: 'modifier',

  triggers: [
    { type: 'state_changed', entity: 'input_select.house_active_mode_modifier' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const modifier = state('input_select.house_active_mode_modifier')?.state;

    if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
      return abort(`modifier_unavailable:${modifier}`);
    }

    return {
      modifier,
      inputs: { modifier },
    };
  },

  reduce: (ctx) => {
    const { modifier } = ctx;

    const guestActive = modifier === 'guest';

    return {
      decision: guestActive ? 'guest_active' : 'guest_inactive',
      reason: `modifier_is_${modifier}`,
      inputs: ctx.inputs,
      actions: [
        {
          type: 'ha.call_service',
          domain: 'input_boolean',
          service: guestActive ? 'turn_on' : 'turn_off',
          target: { entity_id: 'input_boolean.home_office_automation_presence_override' },
        },
      ],
    };
  },
});
