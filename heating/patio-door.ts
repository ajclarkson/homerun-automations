import { defineAutomation, abort, HomeAssistant, type Action, type DeclaredDecision } from '@ajclarkson/homerun';
import { WINDOW_GRACE_HELPER, resolveGraceMs } from '../lib/heating-controller-factory.js';

const DOOR_ENTITY = 'binary_sensor.parlour_sensor_door_patio_contact';
const GRACE_TIMER_KEY = 'house:heating:patio_door_grace';

// Suspending or restoring the house's heating is the notable part. The grace-period wait and the
// door events that change nothing are `ignored`.
export const PATIO_DOOR_REASONS = {
  door_open_heating_on: { outcome: 'acted' },
  door_closed_was_suspended: { outcome: 'acted' },
  door_open_within_grace: { outcome: 'ignored' },
  door_open_heating_already_off: { outcome: 'ignored' },
  door_closed_not_suspended: { outcome: 'ignored' },
} as const;

type PatioDoorDecision = DeclaredDecision<typeof PATIO_DOOR_REASONS>;

export default defineAutomation({
  reasons: PATIO_DOOR_REASONS,
  id: 'house:patio_door',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: DOOR_ENTITY },
    { type: 'timer_expired', timerKey: GRACE_TIMER_KEY },
    { type: 'on_start' },
  ],

  context: (state) => {
    const doorEntity = state(DOOR_ENTITY);
    const doorState = doorEntity?.state;
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

    // How much of the grace period is left before an open door suspends heating.
    // Unknown open-since time counts as already past grace — never delay on missing data.
    const graceMs = resolveGraceMs(state(WINDOW_GRACE_HELPER as keyof HAEntities)?.state);
    const openedAtMs = doorEntity?.last_changed ? new Date(doorEntity.last_changed).getTime() : NaN;
    const elapsedMs = Number.isFinite(openedAtMs) ? Date.now() - openedAtMs : Infinity;
    const graceRemainingMs = Math.max(graceMs - elapsedMs, 0);

    return { doorOpen, heatingOn, suspended, graceRemainingMs };
  },

  reduce: (ctx): PatioDoorDecision => {
    const { doorOpen, heatingOn, suspended, graceRemainingMs } = ctx;
    const cancelGrace: Action = { type: 'timer.cancel', timerKey: GRACE_TIMER_KEY };

    if (doorOpen && heatingOn) {
      // A brief in-and-out shouldn't switch the whole house off — wait out the grace period.
      if (graceRemainingMs > 0) {
        return {
          decision: 'pending',
          reason: 'door_open_within_grace',
          actions: [{ type: 'timer.start', timerKey: GRACE_TIMER_KEY, delayMs: graceRemainingMs }],
        };
      }
      return {
        decision: 'suspend',
        reason: 'door_open_heating_on',
        // Flag written before heating off — crash-safe: on_start re-applies suspend if flag is set
        actions: [
          cancelGrace,
          HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.patio_door_heating_suspended' }),
          HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.house_heating_enabled' }),
        ],
      };
    }

    if (!doorOpen && suspended) {
      return {
        decision: 'restore',
        reason: 'door_closed_was_suspended',
        // Heating restored before flag cleared — crash-safe: on_start restores again if both true (idempotent)
        actions: [
          cancelGrace,
          HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.house_heating_enabled' }),
          HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.patio_door_heating_suspended' }),
        ],
      };
    }

    const reason = doorOpen && !heatingOn && !suspended
      ? 'door_open_heating_already_off' as const
      : 'door_closed_not_suspended' as const;

    return { decision: 'no_action', reason, actions: [cancelGrace] };
  },
});
