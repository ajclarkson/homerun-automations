import { defineAutomation, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';

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

// Pushing the room's mode to its heater mirrors a mode the heating automation already reported, so
// it is `ignored`, except when negative power prices upgrade an empty room to comfort: that is
// `acted`. A mode that cannot be turned into a temperature is `declined`. `clamped_from` is the
// unclamped setpoint, null when no clamp applied.
export const HEATING_ACTUATION_REASONS = {
  temperature_set_arbitrage: { outcome: 'acted', facts: ['mode', 'target', 'clamped_from'] },
  temperature_set: { outcome: 'ignored', facts: ['mode', 'target', 'clamped_from'] },
  helper_unavailable: { outcome: 'declined', facts: ['mode'] },
  unknown_mode: { outcome: 'declined', facts: ['mode'] },
  mode_unavailable: { outcome: 'ignored', facts: ['mode'] },
} as const;

type HeatingActuationDecision = DeclaredDecision<typeof HEATING_ACTUATION_REASONS>;

export default defineAutomation({
  reasons: HEATING_ACTUATION_REASONS,
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

  reduce: (ctx): HeatingActuationDecision => {
    const { mode, modeToTemp, arbitrageEligible } = ctx;

    if (!mode || mode === 'unknown' || mode === 'unavailable') {
      return { decision: 'no_action', reason: 'mode_unavailable', facts: { mode: mode ?? null }, actions: [] };
    }

    const raw = modeToTemp[mode];
    if (raw === undefined) {
      const reason = mode in MODE_HELPERS ? 'helper_unavailable' as const : 'unknown_mode' as const;
      return { decision: 'no_action', reason, facts: { mode }, actions: [] };
    }

    const comfortRaw = modeToTemp['comfort'];
    const arbitrageApplied = arbitrageEligible && mode !== 'comfort' && comfortRaw !== undefined;
    const effectiveMode = arbitrageApplied ? 'comfort' : mode;
    const effectiveRaw = arbitrageApplied ? comfortRaw! : raw;

    const temperature = Math.min(Math.max(effectiveRaw, MIN_SETPOINT_C), MAX_SETPOINT_C);
    const facts = { mode: effectiveMode, target: temperature, clamped_from: temperature !== effectiveRaw ? effectiveRaw : null };

    return {
      decision: 'set_temperature',
      reason: arbitrageApplied ? 'temperature_set_arbitrage' : 'temperature_set',
      facts,
      actions: [
        HomeAssistant.climate.set_temperature({ entity_id: 'climate.foreign_office' }, { hvac_mode: 'heat', temperature }),
      ],
    };
  },
});
