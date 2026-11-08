import { defineAutomation, abort, UnavailableInputError, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

const MODE_HELPERS: Record<string, string> = {
  comfort:        'input_number.global_temperature_comfort',
  baseline_day:   'input_number.global_temperature_baseline_day',
  baseline_night: 'input_number.global_temperature_baseline_night',
  minimum:        'input_number.global_temperature_minimum',
};

const isUsableState = (s: unknown) => typeof s === 'string' && s !== 'unavailable' && s !== 'unknown';

const MIN_SETPOINT_C = 5;
const MAX_SETPOINT_C = 25;

// Setting TRV targets follows a heating mode change that the room's own heating automation already
// reports, so it is `ignored`. A room skipped for a missing helper or an unknown mode with nothing
// set is `declined`: that is a fault a person would want to find. Rooms are comma-joined facts,
// null when there are none; `clamped` names the rooms whose helper value was outside the safe range.
export const TRV_ACTUATION_REASONS = {
  trvs_set: { outcome: 'ignored', facts: ['rooms', 'skipped', 'clamped'] },
  trvs_already_set: { outcome: 'ignored', facts: ['rooms'] },
  trvs_not_set: { outcome: 'declined', facts: ['skipped'] },
  no_valid_rooms: { outcome: 'ignored', facts: ['skipped'] },
} as const;

type TrvActuationDecision = DeclaredDecision<typeof TRV_ACTUATION_REASONS>;

const joinedOrNull = (names: string[]) => (names.length > 0 ? names.join(',') : null);

export default defineAutomation({
  reasons: TRV_ACTUATION_REASONS,
  id: 'house:trv_actuation',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: /^sensor\..+_active_heating$/ },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => {
    const modeToTemp: Record<string, number> = {};
    for (const [mode, helper] of Object.entries(MODE_HELPERS)) {
      const val = parseFloat(state(helper as keyof HAEntities)?.state ?? '');
      if (Number.isFinite(val)) modeToTemp[mode] = val;
    }

    // On state_changed, scope to the triggering room only; on_start loads all.
    let targetRooms: string[];
    if (event.type === 'state_changed') {
      // A reload walks the mode sensor through unavailable and unknown; only its real values count.
      if (!isUsableState(event.new_state?.state)) throw new UnavailableInputError(event.entity_id);
      const match = event.entity_id.match(/^sensor\.(.+)_active_heating$/);
      const room = match?.[1];
      targetRooms = room && HEATING_ROOMS.includes(room) ? [room] : [];
    } else {
      targetRooms = [...HEATING_ROOMS];
    }

    const rooms = targetRooms.map(room => ({
      room,
      trvEntity: `climate.${room}_trv`,
      trv: state(`climate.${room}_trv` as keyof HAEntities),
      mode: state(`sensor.${room}_active_heating` as keyof HAEntities)?.state ?? null,
    }));

    return { rooms, modeToTemp };
  },

  reduce: (ctx): TrvActuationDecision => {
    const { rooms, modeToTemp } = ctx;
    const actions = [];
    const setRooms: string[] = [];
    const skippedRooms: string[] = [];
    const clampedRooms: string[] = [];
    const alreadyRooms: string[] = [];
    let fault = false;

    for (const { room, trvEntity, trv, mode } of rooms) {
      if (!mode || mode === 'unknown' || mode === 'unavailable') {
        skippedRooms.push(room);
        continue;
      }

      if (mode === 'off') {
        if (trv?.state === 'off') { alreadyRooms.push(room); continue; }
        actions.push(HomeAssistant.climate.set_hvac_mode({ entity_id: trvEntity }, { hvac_mode: 'off' }));
        setRooms.push(room);
      } else {
        const raw = modeToTemp[mode];
        if (raw === undefined) {
          fault = true;
          skippedRooms.push(room);
          continue;
        }
        const temperature = Math.min(Math.max(raw, MIN_SETPOINT_C), MAX_SETPOINT_C);
        // After an HA reload the mode sensor comes back with the value it had; the TRV already
        // holds that setpoint, so re-sending only wakes the valve.
        if (trv?.state === 'heat' && trv.attributes?.temperature === temperature) { alreadyRooms.push(room); continue; }
        actions.push(HomeAssistant.climate.set_temperature({ entity_id: trvEntity }, { hvac_mode: 'heat', temperature }));
        setRooms.push(room);
        if (temperature !== raw) clampedRooms.push(room);
      }
    }

    const skipped = joinedOrNull(skippedRooms);
    if (actions.length > 0) {
      return { decision: 'set_trvs', reason: 'trvs_set', facts: { rooms: joinedOrNull(setRooms), skipped, clamped: joinedOrNull(clampedRooms) }, actions };
    }
    if (alreadyRooms.length > 0 && !fault) return { decision: 'no_action', reason: 'trvs_already_set', facts: { rooms: joinedOrNull(alreadyRooms) }, actions };
    if (fault) return { decision: 'no_action', reason: 'trvs_not_set', facts: { skipped }, actions };
    return { decision: 'no_action', reason: 'no_valid_rooms', facts: { skipped }, actions };
  },
});
