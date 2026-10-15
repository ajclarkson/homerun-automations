import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './octopus-wheel-of-fortune.js';

const ELEC = 'sensor.octopus_energy_a_644e00d3_wheel_of_fortune_spins_electricity';
const GAS = 'sensor.octopus_energy_a_644e00d3_wheel_of_fortune_spins_gas';

const spinsChanged = (entity: string) => ({
  type: 'state_changed' as const,
  entity_id: entity,
  old_state: { entity_id: entity, state: '2', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: entity, state: '1', attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});
const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };

const spinTargets = (actions: unknown[]) =>
  (actions as { domain: string; service: string; target: { entity_id: string } }[])
    .filter((a) => a.domain === 'octopus_energy' && a.service === 'spin_wheel_of_fortune')
    .map((a) => a.target.entity_id);

describe('wheel of fortune — spinning available spins', () => {
  it('spins the electricity wheel when it has spins and gas has none', () => {
    const result = testAutomation(automation, { event: onStart, state: { [ELEC]: { state: '2' }, [GAS]: { state: '0' } } });
    expect(spinTargets(result.actions)).toEqual([ELEC]);
  });

  it('spins the gas wheel when it has spins and electricity has none', () => {
    const result = testAutomation(automation, { event: onStart, state: { [ELEC]: { state: '0' }, [GAS]: { state: '1' } } });
    expect(spinTargets(result.actions)).toEqual([GAS]);
  });

  it('spins both wheels when both have spins', () => {
    const result = testAutomation(automation, { event: onStart, state: { [ELEC]: { state: '2' }, [GAS]: { state: '2' } } });
    expect(spinTargets(result.actions)).toEqual([ELEC, GAS]);
  });

  it('requests one spin per wheel per run, relying on the sensor change to trigger the next', () => {
    const result = testAutomation(automation, { event: onStart, state: { [ELEC]: { state: '2' }, [GAS]: { state: '0' } } });
    expect(result.actions).toHaveLength(1);
  });

  it.each([
    ['a wheel sensor changes', spinsChanged(GAS)],
    ['homerun starts', onStart],
  ])('spins when %s', (_label, event) => {
    const result = testAutomation(automation, { event, state: { [ELEC]: { state: '1' }, [GAS]: { state: '1' } } });
    expect(spinTargets(result.actions)).toEqual([ELEC, GAS]);
  });
});

describe('wheel of fortune — no spins to use', () => {
  it('does nothing once both wheels are at zero', () => {
    expect(testAbort(automation, { event: spinsChanged(ELEC), state: { [ELEC]: { state: '0' }, [GAS]: { state: '0' } } }))
      .toMatchObject({ reason: 'no_spins_available' });
  });

  it.each(['unavailable', 'unknown', '', 'abc'])('does nothing when the sensors read "%s"', (value) => {
    expect(testAbort(automation, { event: onStart, state: { [ELEC]: { state: value }, [GAS]: { state: value } } }))
      .toMatchObject({ reason: 'no_spins_available' });
  });

  it('does nothing when the sensors are missing', () => {
    expect(testAbort(automation, { event: onStart, state: {} })).toMatchObject({ reason: 'no_spins_available' });
  });
});
