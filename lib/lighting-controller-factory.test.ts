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
