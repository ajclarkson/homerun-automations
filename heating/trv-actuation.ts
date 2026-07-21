import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

const MODE_HELPERS: Record<string, string> = {
  comfort:        'input_number.global_temperature_comfort',
  baseline_day:   'input_number.global_temperature_baseline_day',
  baseline_night: 'input_number.global_temperature_baseline_night',
  minimum:        'input_number.global_temperature_minimum',
};

const MODE_DEFAULTS: Record<string, number> = {
  comfort: 20, baseline_day: 18, baseline_night: 16, minimum: 5,
};

const MIN_SETPOINT_C = 5;
const MAX_SETPOINT_C = 25;

export default defineAutomation({
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
      const val = parseFloat(state(helper)?.state ?? '');
      modeToTemp[mode] = Number.isFinite(val) ? val : MODE_DEFAULTS[mode];
    }

    // On state_changed, scope to the triggering room only; on_start loads all.
    let targetRooms: string[];
    if (event.type === 'state_changed') {
      const match = event.entity_id.match(/^sensor\.(.+)_active_heating$/);
      const room = match?.[1];
      targetRooms = room && HEATING_ROOMS.includes(room) ? [room] : [];
    } else {
      targetRooms = [...HEATING_ROOMS];
    }

    const rooms = targetRooms.map(room => ({
      room,
      trvEntity: `climate.${room}_trv`,
      mode: state(`sensor.${room}_active_heating`)?.state ?? null,
    }));

    return { rooms, modeToTemp, inputs: { rooms, modeToTemp } };
  },

  reduce: (ctx) => {
    const { rooms, modeToTemp } = ctx;
    const actions = [];
    const roomSummary: string[] = [];

    for (const { room, trvEntity, mode } of rooms) {
      if (!mode || mode === 'unknown' || mode === 'unavailable') {
        roomSummary.push(`${room}:skipped(${mode ?? 'null'})`);
        continue;
      }

      if (mode === 'off') {
        actions.push(HomeAssistant.climate.set_hvac_mode({ entity_id: trvEntity }, { hvac_mode: 'off' }));
        roomSummary.push(`${room}:off`);
      } else {
        const raw = modeToTemp[mode];
        if (raw === undefined) {
          roomSummary.push(`${room}:skipped(unknown_mode:${mode})`);
          continue;
        }
        const temperature = Math.min(Math.max(raw, MIN_SETPOINT_C), MAX_SETPOINT_C);
        actions.push(HomeAssistant.climate.set_temperature({ entity_id: trvEntity }, { hvac_mode: 'heat', temperature }));
        const clampNote = temperature !== raw ? `(clamped_from_${raw})` : '';
        roomSummary.push(`${room}:${mode}@${temperature}${clampNote}`);
      }
    }

    return {
      decision: actions.length > 0 ? 'set_trvs' : 'no_action',
      reason: roomSummary.length > 0 ? roomSummary.join(';') : 'no_valid_rooms',
      inputs: ctx.inputs,
      actions,
    };
  },
});
