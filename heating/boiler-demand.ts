import { defineAutomation, abort, type DeclaredDecision } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';
import { unconfirmedRooms } from '../lib/trv-confirmation.js';

// A boiler call starting or stopping is what a person notices (`acted`). The publish is repeated on
// every TRV flip, so a repeat of the state the boiler is already in is `ignored`. The rooms are one
// comma-joined fact so the reason stays static. `heating_disabled` is `acted` only when the master
// switch was just flipped; any other trigger finding it off is `heating_disabled_idle`. After a
// homerun restart nothing has changed, so the startup runs use the ignored variants.
// A TRV whose temperature feed is not being confirmed (see lib/trv-confirmation.ts) cannot call the
// boiler: its `heat_required` is a stale cache. `demand_withheld` is the boiler going off because every
// calling room is unconfirmed; its `_idle` twin is the same state repeated by the 5-minute schedule
// check or a restart. The unconfirmed rooms are comma-joined facts, empty when there are none.
export const BOILER_DEMAND_REASONS = {
  demand_started: { outcome: 'acted', facts: ['rooms', 'unconfirmed_rooms'] },
  demand_ended: { outcome: 'acted' },
  demand_withheld: { outcome: 'acted', facts: ['unconfirmed_rooms'] },
  heating_disabled: { outcome: 'acted' },
  demand: { outcome: 'ignored', facts: ['rooms', 'unconfirmed_rooms'] },
  demand_withheld_idle: { outcome: 'ignored', facts: ['unconfirmed_rooms'] },
  no_demand: { outcome: 'ignored' },
  heating_disabled_idle: { outcome: 'ignored' },
} as const;

type BoilerDecision = DeclaredDecision<typeof BOILER_DEMAND_REASONS>;

const BOILER_TOPIC = 'zigbee2mqtt/boiler_receiver/set';
const SETPOINT_ON_C = 30;
const SETPOINT_OFF_C = 5;
// The receiver's own setpoint is the prior demand state: it is what this automation last published.
const RECEIVER_ENTITY = 'climate.boiler_receiver_heat';
const CALLING_THRESHOLD_C = (SETPOINT_ON_C + SETPOINT_OFF_C) / 2;
const HEATING_SWITCH = 'input_boolean.house_heating_enabled';

// Was the boiler already being called? Null when the receiver's setpoint is missing or not a number:
// an unknown prior makes the caller pick the acted variant, so a real change is never hidden.
// Zigbee2mqtt confirms a new setpoint within about a second, so two flips inside that window can
// misclassify once; that is acceptable.
function wasCalling(setpoint: unknown): boolean | null {
  const value = typeof setpoint === 'number' ? setpoint : typeof setpoint === 'string' ? Number(setpoint) : NaN;
  if (typeof setpoint === 'string' && setpoint.trim() === '') return null;
  return Number.isFinite(value) ? value >= CALLING_THRESHOLD_C : null;
}

export default defineAutomation({
  reasons: BOILER_DEMAND_REASONS,
  id: 'house:boiler_demand',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: /^binary_sensor\..+_trv_heat_required$/ },
    { type: 'state_changed', entity: 'input_boolean.house_heating_enabled' },
    { type: 'on_start' },
    // Staleness develops with no state change, so the check has to be polled.
    { type: 'schedule', cron: '*/5 * * * *' },
  ],

  context: (state, _ha, event) => {
    const heatingEnabledState = state('input_boolean.house_heating_enabled')?.state;
    if (!heatingEnabledState || heatingEnabledState === 'unavailable' || heatingEnabledState === 'unknown') {
      return abort(`heating_enabled_unavailable:${heatingEnabledState}`);
    }

    const heatingEnabled = heatingEnabledState === 'on';
    const heatRequiredRooms = HEATING_ROOMS.filter(
      room => state(`binary_sensor.${room}_trv_heat_required` as keyof HAEntities)?.state === 'on'
    );
    // The framework has no clock; Date.now() is read here, in the context builder, and passed down.
    const unconfirmed = unconfirmedRooms(HEATING_ROOMS, id => state(id as keyof HAEntities), Date.now());
    const withheldRooms = heatRequiredRooms.filter(room => unconfirmed.includes(room));
    const callingRooms = heatRequiredRooms.filter(room => !unconfirmed.includes(room));
    const demand = callingRooms.length > 0;

    return {
      heatingEnabled,
      callingRooms,
      withheldRooms,
      demand,
      startup: event.type === 'on_start',
      switchFlipped: event.type === 'state_changed' && event.entity_id === HEATING_SWITCH,
      prior: wasCalling(state(RECEIVER_ENTITY as keyof HAEntities)?.attributes?.['temperature']),
    };
  },

  reduce: (ctx): BoilerDecision => {
    const { heatingEnabled, callingRooms, withheldRooms, demand, startup, switchFlipped, prior } = ctx;

    const actions = (setpoint: number) => [{
      type: 'mqtt.publish' as const,
      topic: BOILER_TOPIC,
      payload: JSON.stringify({
        system_mode_heat: 'heat',
        temperature_setpoint_hold_heat: 1,
        occupied_heating_setpoint_heat: setpoint,
      }),
      retain: false,
    }];

    if (!heatingEnabled) {
      const reason = switchFlipped && !startup ? 'heating_disabled' : 'heating_disabled_idle';
      return { decision: 'boiler_off', reason, actions: actions(SETPOINT_OFF_C) };
    }
    if (demand) {
      const reason = startup || prior === true ? 'demand' : 'demand_started';
      return { decision: 'boiler_on', reason, facts: { rooms: callingRooms.join(','), unconfirmed_rooms: withheldRooms.join(',') }, actions: actions(SETPOINT_ON_C) };
    }
    if (withheldRooms.length > 0) {
      const reason = startup || prior === false ? 'demand_withheld_idle' : 'demand_withheld';
      return { decision: 'boiler_off', reason, facts: { unconfirmed_rooms: withheldRooms.join(',') }, actions: actions(SETPOINT_OFF_C) };
    }
    if (startup || prior === false) return { decision: 'boiler_off', reason: 'no_demand', actions: actions(SETPOINT_OFF_C) };
    return { decision: 'boiler_off', reason: 'demand_ended', actions: actions(SETPOINT_OFF_C) };
  },
});
