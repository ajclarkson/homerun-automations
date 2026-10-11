import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';

const MODE_HELPERS: Record<string, string> = {
  comfort:        'input_number.global_temperature_comfort',
  baseline_day:   'input_number.global_temperature_baseline_day',
  baseline_night: 'input_number.global_temperature_baseline_night',
  minimum:        'input_number.global_temperature_minimum',
};

const MIN_SETPOINT_C = 5;
const MAX_SETPOINT_C = 25;

const PRICE_ENTITY = 'sensor.octopus_energy_electricity_24e8140196_1012483035417_current_rate';
const OCCUPIED_ENTITY = 'binary_sensor.foreign_office_occupied';
const SOURCE_ENTITY = 'sensor.foreign_office_heating_source';

export default defineAutomation({
  id: 'foreign_office:heating_actuation',
  location: 'foreign_office',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'sensor.foreign_office_active_heating' },
    { type: 'state_changed', entity: PRICE_ENTITY as keyof HAEntities },
    { type: 'state_changed', entity: OCCUPIED_ENTITY as keyof HAEntities },
    { type: 'state_changed', entity: SOURCE_ENTITY as keyof HAEntities },
    { type: 'on_start' },
  ],

  context: (state) => {
    const modeToTemp: Record<string, number> = {};
    for (const [mode, helper] of Object.entries(MODE_HELPERS)) {
      const val = parseFloat(state(helper as keyof HAEntities)?.state ?? '');
      if (Number.isFinite(val)) modeToTemp[mode] = val;
    }

    const mode = state('sensor.foreign_office_active_heating')?.state ?? null;

    const price = parseFloat(state(PRICE_ENTITY as keyof HAEntities)?.state ?? '');
    const priceNegative = Number.isFinite(price) && price < 0;

    // Unavailable/unknown occupancy is treated as occupied — never heat an
    // empty room for arbitrage on the strength of a missing sensor reading.
    const occupied = state(OCCUPIED_ENTITY as keyof HAEntities)?.state !== 'off';

    const source = state(SOURCE_ENTITY as keyof HAEntities)?.state ?? null;

    // Only upgrades the schedule's own idle default — never overrides a
    // manual choice or a safety-forced minimum.
    const arbitrageEligible = source === 'schedule' && !occupied && priceNegative;

    return { mode, modeToTemp, arbitrageEligible };
  },

  reduce: (ctx) => {
    const { mode, modeToTemp, arbitrageEligible } = ctx;

    if (!mode || mode === 'unknown' || mode === 'unavailable') {
      return { decision: 'no_action', reason: `mode_unavailable:${mode}`, actions: [] };
    }

    const raw = modeToTemp[mode];
    if (raw === undefined) {
      const reason = mode in MODE_HELPERS ? `helper_unavailable:${mode}` : `unknown_mode:${mode}`;
      return { decision: 'no_action', reason, actions: [] };
    }

    const comfortRaw = modeToTemp['comfort'];
    const arbitrageApplied = arbitrageEligible && mode !== 'comfort' && comfortRaw !== undefined;
    const effectiveMode = arbitrageApplied ? 'comfort' : mode;
    const effectiveRaw = arbitrageApplied ? comfortRaw! : raw;

    const temperature = Math.min(Math.max(effectiveRaw, MIN_SETPOINT_C), MAX_SETPOINT_C);
    const clampNote = temperature !== effectiveRaw ? `(clamped_from_${effectiveRaw})` : '';
    const arbitrageNote = arbitrageApplied ? '+arbitrage_negative_price' : '';

    return {
      decision: 'set_temperature',
      reason: `${effectiveMode}@${temperature}${clampNote}${arbitrageNote}`,
      actions: [
        HomeAssistant.climate.set_temperature({ entity_id: 'climate.foreign_office' }, { hvac_mode: 'heat', temperature }),
      ],
    };
  },
});
