import { defineAutomation, abort, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';

const OVERTEMP_THRESHOLD_C = 25;

// Switching the heater off for overtemperature is the notable event; the rest is monitoring.
export const OVERTEMP_SAFETY_REASONS = {
  overtemp_heater_on: { outcome: 'acted', facts: ['temp'] },
  overtemp_heater_already_off: { outcome: 'ignored' },
  temp_normal: { outcome: 'ignored' },
} as const;

type OvertempDecision = DeclaredDecision<typeof OVERTEMP_SAFETY_REASONS>;

export default defineAutomation({
  reasons: OVERTEMP_SAFETY_REASONS,
  id: 'foreign_office:overtemp_safety',
  location: 'foreign_office',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: 'sensor.foreign_office_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'switch.foreign_office_plug_heater' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const heaterState = state('switch.foreign_office_plug_heater')?.state;
    if (!heaterState || heaterState === 'unavailable' || heaterState === 'unknown') {
      return abort(`heater_unavailable:${heaterState}`);
    }

    const tempStr = state('sensor.foreign_office_sensor_climate_temperature')?.state;
    const temp = parseFloat(tempStr ?? '');
    if (!Number.isFinite(temp)) {
      return abort(`temp_unavailable:${tempStr}`);
    }

    return {
      temp,
      heaterOn: heaterState === 'on',
    };
  },

  reduce: (ctx): OvertempDecision => {
    const { temp, heaterOn } = ctx;

    if (temp > OVERTEMP_THRESHOLD_C && heaterOn) {
      return {
        decision: 'turn_off_heater',
        reason: 'overtemp_heater_on',
        facts: { temp: Math.round(temp * 10) / 10 },
        actions: [
          HomeAssistant.switch.turn_off({ entity_id: 'switch.foreign_office_plug_heater' }),
        ],
      };
    }

    return {
      decision: 'no_action',
      reason: temp > OVERTEMP_THRESHOLD_C ? 'overtemp_heater_already_off' : 'temp_normal',
      actions: [],
    };
  },
});
