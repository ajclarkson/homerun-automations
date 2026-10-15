import { defineAutomation, abort } from '@ajclarkson/homerun';

const WHEELS = [
  'sensor.octopus_energy_a_644e00d3_wheel_of_fortune_spins_electricity',
  'sensor.octopus_energy_a_644e00d3_wheel_of_fortune_spins_gas',
] as const;

function spinAction(entity: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'octopus_energy',
    service: 'spin_wheel_of_fortune',
    target: { entity_id: entity },
  };
}

// Spins the electricity and gas wheels whenever a spin is available. Spins are granted monthly and
// don't roll over, so there's never a reason to wait. One spin is requested per wheel per run; each
// spin changes the sensor, which re-triggers this until the count reaches zero. on_start catches
// spins granted while offline.
export default defineAutomation({
  id: 'house:octopus_wheel_of_fortune_spin',
  location: 'house',
  subsystem: 'energy',

  triggers: [
    ...WHEELS.map((entity) => ({ type: 'state_changed' as const, entity })),
    { type: 'on_start' },
  ],

  context: (state) => {
    const spinnable = WHEELS.filter((entity) => {
      const spins = Number(state(entity)?.state);
      return Number.isFinite(spins) && spins > 0;
    });

    if (spinnable.length === 0) return abort('no_spins_available');

    return { spinnable };
  },

  reduce: (ctx) => ({
    decision: 'spin',
    reason: `${ctx.spinnable.length}_wheel${ctx.spinnable.length === 1 ? '' : 's'}`,
    actions: ctx.spinnable.map(spinAction),
  }),
});
