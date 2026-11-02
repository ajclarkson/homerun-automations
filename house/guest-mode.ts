import { defineAutomation, abort, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';

// Guest mode starting or ending moves the home office presence override, so both are `acted`.
// The `_startup` twins are a homerun restart re-asserting the current modifier: `ignored`.
// The modifier is a fact, so the reason is not built from its value.
export const GUEST_MODE_REASONS = {
  guest_present: { outcome: 'acted', facts: ['modifier'] },
  guest_absent: { outcome: 'acted', facts: ['modifier'] },
  guest_present_startup: { outcome: 'ignored', facts: ['modifier'] },
  guest_absent_startup: { outcome: 'ignored', facts: ['modifier'] },
} as const;

type GuestModeDecision = DeclaredDecision<typeof GUEST_MODE_REASONS>;

export default defineAutomation({
  reasons: GUEST_MODE_REASONS,
  id: 'house:guest_mode',
  location: 'house',
  subsystem: 'modifier',

  triggers: [
    { type: 'state_changed', entity: 'input_select.house_active_mode_modifier' },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => {
    const modifier = state('input_select.house_active_mode_modifier')?.state;

    if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
      return abort(`modifier_unavailable:${modifier}`);
    }

    return {
      modifier,
      startup: event.type === 'on_start',
    };
  },

  reduce: (ctx): GuestModeDecision => {
    const { modifier, startup } = ctx;

    const guestActive = modifier === 'guest';

    return {
      decision: guestActive ? 'guest_active' : 'guest_inactive',
      reason: guestActive
        ? (startup ? 'guest_present_startup' : 'guest_present')
        : (startup ? 'guest_absent_startup' : 'guest_absent'),
      facts: { modifier },
      actions: [
        guestActive
          ? HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.home_office_automation_presence_override' })
          : HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.home_office_automation_presence_override' }),
      ],
    };
  },
});
