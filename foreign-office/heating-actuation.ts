import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';

const MODE_HELPERS: Record<string, string> = {
  comfort:        'input_number.global_temperature_comfort',
  baseline_day:   'input_number.global_temperature_baseline_day',
  baseline_night: 'input_number.global_temperature_baseline_night',
  minimum:        'input_number.global_temperature_minimum',
};

const MIN_SETPOINT_C = 5;
const MAX_SETPOINT_C = 25;

export default defineAutomation({
  id: 'foreign_office:heating_actuation',
  location: 'foreign_office',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'sensor.foreign_office_active_heating' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const modeToTemp: Record<string, number> = {};
    for (const [mode, helper] of Object.entries(MODE_HELPERS)) {
      const val = parseFloat(state(helper as keyof HAEntities)?.state ?? '');
      if (Number.isFinite(val)) modeToTemp[mode] = val;
    }

    const mode = state('sensor.foreign_office_active_heating')?.state ?? null;

    return { mode, modeToTemp };
  },

  reduce: (ctx) => {
    const { mode, modeToTemp } = ctx;

    if (!mode || mode === 'unknown' || mode === 'unavailable') {
      return { decision: 'no_action', reason: `mode_unavailable:${mode}`, actions: [] };
    }

    const raw = modeToTemp[mode];
    if (raw === undefined) {
      const reason = mode in MODE_HELPERS ? `helper_unavailable:${mode}` : `unknown_mode:${mode}`;
      return { decision: 'no_action', reason, actions: [] };
    }

    const temperature = Math.min(Math.max(raw, MIN_SETPOINT_C), MAX_SETPOINT_C);
    const clampNote = temperature !== raw ? `(clamped_from_${raw})` : '';

    return {
      decision: 'set_temperature',
      reason: `${mode}@${temperature}${clampNote}`,
      actions: [
        HomeAssistant.climate.set_temperature({ entity_id: 'climate.foreign_office' }, { hvac_mode: 'heat', temperature }),
      ],
    };
  },
});
