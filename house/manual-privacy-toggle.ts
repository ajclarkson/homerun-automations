import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

// A deliberate double press toggles the cameras' privacy: always something a person notices.
export const MANUAL_PRIVACY_TOGGLE_REASONS = {
  // `privacy` is the state the press leaves the cameras in: on means the cameras are off.
  button_double_press: { outcome: 'acted', facts: ['privacy'] },
} as const;

export default defineAutomation({
  reasons: MANUAL_PRIVACY_TOGGLE_REASONS,
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
    };
  },

  reduce: (ctx) => ({
    decision: ctx.privacyOn ? 'disable_privacy' : 'enable_privacy',
    reason: 'button_double_press',
    facts: { privacy: ctx.privacyOn ? 'off' : 'on' },
    actions: [
      ctx.privacyOn
        ? HomeAssistant.switch.turn_off({ entity_id: 'group.cameras_privacy' })
        : HomeAssistant.switch.turn_on({ entity_id: 'group.cameras_privacy' }),
    ],
  }),
});
