import { defineAutomation, abort } from '@ajclarkson/homerun';
import { Services } from '../types/ha-services.js';

export default defineAutomation({
  id: 'house:manual_privacy_toggle',
  location: 'house',
  subsystem: 'cameras',

  triggers: [
    { type: 'button', entity: 'sensor.hallway_downstairs_button_wall_action', gesture: 'double_press' },
  ],

  context: (state) => {
    const privacyState = state('switch.parlour_privacy')?.state;

    if (!privacyState || privacyState === 'unavailable' || privacyState === 'unknown') {
      return abort(`privacy_switch_unavailable:${privacyState}`);
    }

    return {
      privacyOn: privacyState === 'on',
      inputs: { privacyState },
    };
  },

  reduce: (ctx) => ({
    decision: ctx.privacyOn ? 'disable_privacy' : 'enable_privacy',
    reason: 'button_double_press',
    inputs: ctx.inputs,
    actions: [
      ctx.privacyOn
        ? Services.switch.turn_off({ entity_id: 'group.cameras_privacy' })
        : Services.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
    ],
  }),
});
