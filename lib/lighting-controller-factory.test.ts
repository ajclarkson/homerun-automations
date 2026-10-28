import { describe, it, expect } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import { makeLightingAutomation } from './lighting-controller-factory.js';

const LOCATION = 'test_room';

const automation = makeLightingAutomation({ location: LOCATION, disableInSleepMode: false });
const automationSleepBlocked = makeLightingAutomation({ location: LOCATION, disableInSleepMode: true });

// Standard scene setup: off, low (night/order_1), daylight (order_2)
function makeHa(opts: { suppressEntity?: string } = {}): Partial<HAContext> {
  const area = [
    `scene.${LOCATION}_off`,
    `scene.${LOCATION}_low`,
    `scene.${LOCATION}_daylight`,
    ...(opts.suppressEntity ? [opts.suppressEntity] : []),
  ];
  const labelMap: Record<string, string[]> = {
    scene_control_off: [`scene.${LOCATION}_off`],
    scene_control_daylight: [`scene.${LOCATION}_daylight`],
    scene_control_night: [`scene.${LOCATION}_low`],
    scene_order_1: [`scene.${LOCATION}_low`],
    scene_order_2: [`scene.${LOCATION}_daylight`],
    lighting_suppress_when_on: opts.suppressEntity ? [opts.suppressEntity] : [],
  };
  return {
    entitiesByArea: (a) => (a === LOCATION ? area : []),
    entitiesByLabel: (label) => labelMap[label] ?? [],
  };
}

const baseState = {
  'sensor.house_active_mode': { state: 'normal' },
  'input_select.house_active_mode_modifier': { state: 'none' },
  [`binary_sensor.${LOCATION}_occupied`]: { state: 'off' },
  [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' },
  [`input_number.${LOCATION}_automation_lux_threshold_dark`]: { state: '15' },
  [`sensor.${LOCATION}_sensor_motion_illuminance`]: { state: '10' },
  [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` },
  [`binary_sensor.${LOCATION}_lighting_recent_auto_off`]: { state: 'off' },
  [`input_boolean.${LOCATION}_automation_presence_override`]: { state: 'off' },
  'sun.sun': { state: 'below_horizon' },
};

const occupancyEvent = (to: 'on' | 'off') => ({
  type: 'state_changed' as const,
  entity_id: `binary_sensor.${LOCATION}_occupied`,
  old_state: { entity_id: `binary_sensor.${LOCATION}_occupied`, state: to === 'on' ? 'off' : 'on', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: `binary_sensor.${LOCATION}_occupied`, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const buttonEvent = (gesture: 'single_press' | 'hold') => ({
  type: 'button' as const,
  entity_id: `sensor.${LOCATION}_button_wall_action`,
  gesture,
  correlation_id: 'test-cid',
});

const houseModeEvent = (mode: string) => ({
  type: 'state_changed' as const,
  entity_id: 'sensor.house_active_mode',
  old_state: { entity_id: 'sensor.house_active_mode', state: 'normal', attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: 'sensor.house_active_mode', state: mode, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'test-cid',
});

const timerEvent = () => ({
  type: 'timer_expired' as const,
  timerKey: `${LOCATION}:lighting_recent_auto_off`,
  correlation_id: 'test-cid',
});

const onStartEvent = () => ({
  type: 'on_start' as const,
  correlation_id: 'test-cid',
});

describe('makeLightingAutomation', () => {
  describe('occupancy on', () => {
    it('activates night scene when lux is low at night', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: { ...baseState, [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' } },
        ha: makeHa(),
      });
      expect(result).toMatchObject({
        decision: 'activate_scene',
        reason: 'lux_low',
        actions: expect.arrayContaining([
          { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: `scene.${LOCATION}_low` }, data: { transition: 0.5 } },
        ]),
      });
    });

    it('activates daylight scene when lux is low during the day', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          'sun.sun': { state: 'above_horizon' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({
        decision: 'activate_scene',
        reason: 'lux_low',
        actions: expect.arrayContaining([
          { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: `scene.${LOCATION}_daylight` }, data: { transition: 0.5 } },
        ]),
      });
    });

    it('does not activate when lux is above threshold', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [`sensor.${LOCATION}_sensor_motion_illuminance`]: { state: '100' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'lux_high' });
    });

    it('does not activate when lights are already on', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_low` },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'already_on' });
    });

    it('activates regardless of lux when recent_auto_off is set', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [`sensor.${LOCATION}_sensor_motion_illuminance`]: { state: '100' },
          [`binary_sensor.${LOCATION}_lighting_recent_auto_off`]: { state: 'on' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'activate_scene', reason: 'recent_auto_off' });
    });
  });

  describe('occupancy off', () => {
    it('turns off lights and sets recent_auto_off', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('off'),
        state: baseState,
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'occupancy_off' });
      expect(result.actions).toContainEqual({
        type: 'ha.call_service', domain: 'scene', service: 'turn_on',
        target: { entity_id: `scene.${LOCATION}_off` }, data: { transition: 0.5 },
      });
      expect(result.actions).toContainEqual({
        type: 'mqtt.publish', topic: `${LOCATION}/lighting/recent_auto_off`, payload: 'ON', retain: true, impliesEntity: `binary_sensor.${LOCATION}_lighting_recent_auto_off`,
      });
      expect(result.actions).toContainEqual(
        expect.objectContaining({ type: 'timer.start', timerKey: `${LOCATION}:lighting_recent_auto_off` }),
      );
    });
  });

  describe('occupancy sensor outage / HA restart', () => {
    const SETTLE_KEY = `${LOCATION}:lighting_occupancy_settle`;
    const LIT = { ...baseState, [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_low` } };
    const withSensor = (st: string, base: typeof baseState = LIT) => ({ ...base, [`binary_sensor.${LOCATION}_occupied`]: { state: st } });
    const transition = (from: string | null, to: string) => ({
      type: 'state_changed' as const,
      entity_id: `binary_sensor.${LOCATION}_occupied`,
      old_state: from === null ? null : { entity_id: `binary_sensor.${LOCATION}_occupied`, state: from, attributes: {}, last_changed: '', last_updated: '' },
      new_state: { entity_id: `binary_sensor.${LOCATION}_occupied`, state: to, attributes: {}, last_changed: '', last_updated: '' },
      correlation_id: 'test-cid',
    });
    const settleEvent = () => ({ type: 'timer_expired' as const, timerKey: SETTLE_KEY, correlation_id: 'test-cid' });
    const run = (event: any, state: any) => testAutomation(automation, { event, state, ha: makeHa() });
    const types = (r: any) => r.actions.map((a: any) => a.type);
    const hasOffScene = (r: any) => r.actions.some((a: any) => a.type === 'ha.call_service' && JSON.stringify(a).includes(`${LOCATION}_off`));
    const publishesAutoOff = (r: any) => r.actions.some((a: any) => a.type === 'mqtt.publish');

    it.each([
      ['off', 'unavailable'],
      ['on', 'unavailable'],
      [null, 'unavailable'],
      ['unavailable', 'unknown'],
      ['on', 'unknown'],
    ] as const)('new state invalid (%s -> %s): no scene, no publish, no timer', (from, to) => {
      const result = run(transition(from, to), withSensor(to));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'occupancy_sensor_not_valid' });
      expect(result.actions).toEqual([]);
    });

    it.each(['unavailable', 'unknown'] as const)('%s -> off starts a settle timer without touching lights', (from) => {
      const result = run(transition(from, 'off'), withSensor('off'));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'occupancy_settle_pending' });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: SETTLE_KEY, delayMs: 300_000 }]);
    });

    it('null -> off (fresh process) also starts a settle timer', () => {
      const result = run(transition(null, 'off'), withSensor('off'));
      expect(result).toMatchObject({ reason: 'occupancy_settle_pending' });
    });

    it('does not start a settle timer when automation is disabled', () => {
      const result = run(transition('unknown', 'off'), { ...withSensor('off'), [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } });
      expect(result.reason).toBe('automation_disabled');
      expect(types(result)).not.toContain('timer.start');
    });

    it('sensor returning on after an outage cancels the settle timer and leaves lights alone', () => {
      const result = run(transition('unknown', 'on'), withSensor('on'));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'occupancy_sensor_restored_on' });
      expect(result.actions).toEqual([{ type: 'timer.cancel', timerKey: SETTLE_KEY }]);
    });

    it('restart, room emptied: lights are turned off when the settle timer fires', () => {
      const steps = [transition(null, 'unavailable'), transition('unavailable', 'unknown'), transition('unknown', 'off')];
      const results = steps.map((e) => run(e, withSensor(e.new_state.state)));
      expect(results.map((r) => r.reason)).toEqual(['occupancy_sensor_not_valid', 'occupancy_sensor_not_valid', 'occupancy_settle_pending']);
      results.forEach((r) => expect(hasOffScene(r)).toBe(false));
      const fired = run(settleEvent(), withSensor('off'));
      expect(fired).toMatchObject({ decision: 'turn_off', reason: 'occupancy_settle_off' });
      expect(hasOffScene(fired)).toBe(true);
      expect(fired.actions).toContainEqual({ type: 'timer.start', timerKey: `${LOCATION}:lighting_recent_auto_off`, delayMs: 300_000 });
      expect(publishesAutoOff(fired)).toBe(true);
    });

    it('restart, room still occupied: off -> on within the delay cancels the timer and leaves lights untouched', () => {
      const pending = run(transition('unknown', 'off'), withSensor('off'));
      expect(pending.reason).toBe('occupancy_settle_pending');
      const back = run(transition('off', 'on'), withSensor('on'));
      expect(types(back)).toContain('timer.cancel');
      expect(back.actions).toContainEqual({ type: 'timer.cancel', timerKey: SETTLE_KEY });
      expect(hasOffScene(back)).toBe(false);
      // Even if the cancel were lost, firing with sensor on does nothing.
      const fired = run(settleEvent(), withSensor('on'));
      expect(fired).toMatchObject({ decision: 'no_action', reason: 'occupancy_settle_sensor_on' });
      expect(fired.actions).toEqual([]);
    });

    it.each(['unavailable', 'unknown'])('settle timer firing with sensor %s does nothing and does not re-arm', (st) => {
      const fired = run(settleEvent(), withSensor(st));
      expect(fired).toMatchObject({ decision: 'no_action', reason: 'occupancy_settle_sensor_not_valid' });
      expect(fired.actions).toEqual([]);
    });

    it('settle timer firing with lights already off does nothing', () => {
      const fired = run(settleEvent(), withSensor('off', baseState));
      expect(fired).toMatchObject({ decision: 'no_action', reason: 'occupancy_settle_already_off' });
      expect(fired.actions).toEqual([]);
    });

    it('genuine on -> off still turns the room off and also cancels a pending settle timer', () => {
      const result = run(occupancyEvent('off'), LIT);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'occupancy_off' });
      expect(hasOffScene(result)).toBe(true);
      expect(result.actions).toContainEqual({ type: 'timer.start', timerKey: `${LOCATION}:lighting_recent_auto_off`, delayMs: 300_000 });
      expect(result.actions).toContainEqual({ type: 'timer.cancel', timerKey: SETTLE_KEY });
    });

    it('custom occupancySettleMins is used and clamped', () => {
      const custom = makeLightingAutomation({ location: LOCATION, occupancySettleMins: 1000 });
      const r = testAutomation(custom, { event: transition('unknown', 'off') as any, state: withSensor('off'), ha: makeHa() });
      expect(r.actions).toEqual([{ type: 'timer.start', timerKey: SETTLE_KEY, delayMs: 3_600_000 }]);
    });
  });

  describe('button', () => {
    it('cycles to first ordered scene when active scene is not in cycle', () => {
      const result = testAutomation(automation, {
        event: buttonEvent('single_press'),
        state: baseState,
        ha: makeHa(),
      });
      expect(result).toMatchObject({
        decision: 'activate_scene',
        reason: 'button_cycle',
        actions: expect.arrayContaining([
          { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: `scene.${LOCATION}_low` }, data: { transition: 0.5 } },
        ]),
      });
    });

    it('cycles to next ordered scene when on order_1', () => {
      const result = testAutomation(automation, {
        event: buttonEvent('single_press'),
        state: {
          ...baseState,
          [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_low` },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({
        decision: 'activate_scene',
        reason: 'button_cycle',
        actions: expect.arrayContaining([
          { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: `scene.${LOCATION}_daylight` }, data: { transition: 0.5 } },
        ]),
      });
    });

    it('wraps around to first scene from last ordered scene', () => {
      const result = testAutomation(automation, {
        event: buttonEvent('single_press'),
        state: {
          ...baseState,
          [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_daylight` },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({
        decision: 'activate_scene',
        reason: 'button_cycle',
        actions: expect.arrayContaining([
          { type: 'ha.call_service', domain: 'scene', service: 'turn_on', target: { entity_id: `scene.${LOCATION}_low` }, data: { transition: 0.5 } },
        ]),
      });
    });

    it('turns off on hold and sets recent_auto_off', () => {
      const result = testAutomation(automation, {
        event: buttonEvent('hold'),
        state: baseState,
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'button_off' });
      expect(result.actions).toContainEqual({
        type: 'ha.call_service', domain: 'scene', service: 'turn_on',
        target: { entity_id: `scene.${LOCATION}_off` }, data: { transition: 0.5 },
      });
      expect(result.actions).toContainEqual({
        type: 'mqtt.publish', topic: `${LOCATION}/lighting/recent_auto_off`, payload: 'ON', retain: true, impliesEntity: `binary_sensor.${LOCATION}_lighting_recent_auto_off`,
      });
    });
  });

  describe('house mode → sleep', () => {
    it('turns off lights when house enters sleep mode', () => {
      const result = testAutomation(automation, {
        event: houseModeEvent('sleep'),
        state: baseState,
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'house_sleep_mode' });
    });

    it('bypasses sleep shutoff when guest mode is active', () => {
      const result = testAutomation(automation, {
        event: houseModeEvent('sleep'),
        state: {
          ...baseState,
          'input_select.house_active_mode_modifier': { state: 'guest' },
          [`input_boolean.${LOCATION}_automation_presence_override`]: { state: 'on' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'guest_room_sleep_bypass' });
    });
  });

  describe('disableInSleepMode', () => {
    it('blocks occupancy-triggered on when sleep mode is active', () => {
      const result = testAutomation(automationSleepBlocked, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          'sensor.house_active_mode': { state: 'sleep' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'sleep_mode' });
    });

    it('does not block when disableInSleepMode is false', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          'sensor.house_active_mode': { state: 'sleep' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'activate_scene' });
    });
  });

  describe('external suppression', () => {
    it('blocks occupancy-triggered on when suppress entity is on', () => {
      const suppressEntity = `input_boolean.${LOCATION}_bed_occupied_sync`;
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [suppressEntity]: { state: 'on' },
        },
        ha: makeHa({ suppressEntity }),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'external_suppress_active' });
    });

    it('does not suppress when suppress entity is off', () => {
      const suppressEntity = `input_boolean.${LOCATION}_bed_occupied_sync`;
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [suppressEntity]: { state: 'off' },
        },
        ha: makeHa({ suppressEntity }),
      });
      expect(result).toMatchObject({ decision: 'activate_scene' });
    });
  });

  describe('timer expired', () => {
    it('clears recent_auto_off flag', () => {
      const result = testAutomation(automation, {
        event: timerEvent(),
        state: baseState,
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'clear_recent_auto_off', reason: 'recent_auto_off_expired' });
      expect(result.actions).toContainEqual({
        type: 'mqtt.publish', topic: `${LOCATION}/lighting/recent_auto_off`, payload: 'OFF', retain: true, impliesEntity: `binary_sensor.${LOCATION}_lighting_recent_auto_off`,
      });
    });
  });

  describe('startup', () => {
    it('does not resync the scene on restart, since that would clobber a manual override', () => {
      const result = testAutomation(automation, {
        event: onStartEvent(),
        state: {
          ...baseState,
          [`binary_sensor.${LOCATION}_occupied`]: { state: 'on' },
          [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'startup_check_ok' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('automation disabled', () => {
    it('returns no_action and cancels recent_auto_off', () => {
      const result = testAutomation(automation, {
        event: occupancyEvent('on'),
        state: {
          ...baseState,
          [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' },
        },
        ha: makeHa(),
      });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
    });
  });

  describe('abort', () => {
    it('aborts when no off scene is configured for the room', () => {
      const result = testAbort(automation, {
        event: occupancyEvent('on'),
        state: baseState,
        ha: {
          entitiesByArea: () => [],
          entitiesByLabel: () => [],
        },
      });
      expect(result.reason).toEqual(expect.stringContaining('no_off_scene_configured'));
    });

    it('aborts when the lux threshold helper is missing, surfacing the misconfiguration', () => {
      const { [`input_number.${LOCATION}_automation_lux_threshold_dark`]: _, ...stateWithoutThreshold } = baseState;
      const result = testAbort(automation, {
        event: occupancyEvent('on'),
        state: stateWithoutThreshold,
        ha: makeHa(),
      });
      expect(result.reason).toEqual(expect.stringContaining('lux_threshold_unavailable'));
    });
  });
});
