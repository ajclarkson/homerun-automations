import { describe, it, expect, vi, afterEach } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import { makePorchLightAutomation, MIN_HOLD_S, MAX_HOLD_S, SCENE_SETTLE_MS } from './porch-light-factory.js';

const LOCATION = 'test_garden';
const PORCH = `light.${LOCATION}_light_porch`;
const OTHER_PORCH = `light.${LOCATION}_light_porch_2`;
const MOTION = `binary_sensor.${LOCATION}_sensor_motion_occupancy`;
const HOLD_TIMER = `${LOCATION}:porch_motion_hold`;
const SETTLE_TIMER = `${LOCATION}:porch_scene_settle`;
const NORMAL = `scene.${LOCATION}_all`;
const SPOOKY = `scene.${LOCATION}_spooky`;
const OFF = `scene.${LOCATION}_off`;
const RESTORE = 'scene.porch_motion_restore';

const WARM = { colorTempKelvin: 2700, brightness: 180 };
const config = { location: LOCATION, warm: WARM, fadeUpS: 2, fadeDownS: 5, restoreSceneId: 'porch_motion_restore' };
const automation = makePorchLightAutomation(config);
const optOut = makePorchLightAutomation({ ...config, motionThemes: { spooky: false } });

function makeHa(opts: { porches?: string[]; porchOutsideArea?: boolean } = {}): Partial<HAContext> {
  const porches = opts.porches ?? [PORCH];
  const area = [...(opts.porchOutsideArea ? [] : porches), NORMAL, SPOOKY, OFF];
  const labels: Record<string, string[]> = {
    outdoor_light_porch: ['light.elsewhere_porch', ...porches],
    scene_theme_spooky: ['scene.elsewhere_spooky', SPOOKY],
    scene_control_off: ['scene.elsewhere_off', OFF],
  };
  return { entitiesByArea: (a) => (a === LOCATION ? area : []), entitiesByLabel: (l) => labels[l] ?? [] };
}

const warmLook = { state: 'on', attributes: { brightness: 180, color_temp_kelvin: 2703 } };
const restingLook = { state: 'on', attributes: { brightness: 90, color_temp_kelvin: 2703 } };
const base = {
  [PORCH]: restingLook,
  [MOTION]: { state: 'on' },
  'sun.sun': { state: 'below_horizon' },
  [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' },
  [`input_number.${LOCATION}_automation_porch_hold`]: { state: '30' },
  [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_all` },
  [RESTORE]: { state: '2026-11-01T20:00:00+00:00' },
};

const motion = (to: 'on' | 'off' | 'unavailable') => ({
  type: 'state_changed' as const, entity_id: MOTION,
  old_state: undefined, new_state: { entity_id: MOTION, state: to, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'cid',
});
const sceneChange = (scene: string, newState = '2026-11-01T21:00:00+00:00', oldState = '2026-10-31T21:00:00+00:00') => ({
  type: 'state_changed' as const, entity_id: scene,
  old_state: { entity_id: scene, state: oldState, attributes: {}, last_changed: '', last_updated: '' },
  new_state: { entity_id: scene, state: newState, attributes: {}, last_changed: '', last_updated: '' },
  correlation_id: 'cid',
});
const timer = (timerKey: string) => ({ type: 'timer_expired' as const, timerKey, correlation_id: 'cid' });
const onStart = { type: 'on_start' as const, correlation_id: 'cid' };

type Ev = ReturnType<typeof motion> | ReturnType<typeof sceneChange> | ReturnType<typeof timer> | typeof onStart;
type Overrides = Record<string, unknown>;
const opts = (event: Ev, state: Overrides, ha: Partial<HAContext>) =>
  ({ event, state: { ...base, ...state } as never, ha });
const run = (event: Ev, state: Overrides = {}, ha = makeHa(), a = automation) => testAutomation(a, opts(event, state, ha));
const abortOf = (event: Ev, state: Overrides = {}, ha = makeHa()) => testAbort(automation, opts(event, state, ha));

const snapshotCall = {
  type: 'ha.call_service', domain: 'scene', service: 'create',
  data: { scene_id: 'porch_motion_restore', snapshot_entities: [PORCH] },
};
const warmCall = expect.objectContaining({
  service: 'turn_on', target: { entity_id: PORCH }, data: { color_temp_kelvin: 2700, brightness: 180, transition: 2 },
});
const restoreCall = expect.objectContaining({ domain: 'scene', service: 'turn_on', target: { entity_id: RESTORE }, data: { transition: 5 } });
const cancel = (timerKey: string) => ({ type: 'timer.cancel', timerKey });

afterEach(() => vi.useRealTimers());

describe('Porch light on motion', () => {
  describe('someone arrives in the dark', () => {
    it('takes a snapshot of the porch, then fades to the warm look, in that order', () => {
      const result = run(motion('on'), { [MOTION]: { state: 'on' } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected' });
      expect(result.actions).toEqual([snapshotCall, warmCall, cancel(HOLD_TIMER)]);
    });

    it('warms in every theme when no theme opts out', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected' });
    });

    it('warms after the garden has turned off for the night', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` }, [PORCH]: { state: 'off', attributes: {} } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected' });
    });

    it('warms when no scene has been active yet', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: 'unknown' } });
      expect(result).toMatchObject({ decision: 'warm' });
    });
  });

  describe('when it should stay quiet', () => {
    it('ignores motion in daylight', () => {
      expect(run(motion('on'), { 'sun.sun': { state: 'above_horizon' } })).toMatchObject({ decision: 'no_action', reason: 'daylight', actions: [] });
    });

    it('ignores motion while a theme that opted out is showing', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } }, makeHa(), optOut);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'theme_opted_out', actions: [] });
    });

    it('still reacts under a different theme when only one theme opted out', () => {
      expect(run(motion('on'), {}, makeHa(), optOut)).toMatchObject({ decision: 'warm' });
    });

    it('reacts once the opted-out theme has been replaced by the off scene', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` } }, makeHa(), optOut);
      expect(result).toMatchObject({ decision: 'warm' });
    });

    it('does nothing while the garden lights automation is switched off', () => {
      const result = run(motion('on'), { [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER)]);
    });

    it('puts the porch back if the automation is switched off while it is warm', () => {
      const result = run(motion('off'), { [PORCH]: warmLook, [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'restore', reason: 'automation_disabled' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER), restoreCall]);
    });
  });

  describe('someone keeps moving about', () => {
    it('stays warm without taking a second snapshot, and cancels the fade-back', () => {
      const result = run(motion('on'), { [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'already_warm' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER)]);
    });

    it('does not mistake the resting look for the warm look', () => {
      expect(run(motion('on'), { [PORCH]: { state: 'on', attributes: { brightness: 180, color_temp_kelvin: 4000 } } })).toMatchObject({ decision: 'warm' });
    });
  });

  describe('someone leaves', () => {
    it('starts the hold from the helper when motion clears while warm', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'hold', reason: 'motion_cleared' });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: 30_000 }]);
    });

    it('does nothing when motion clears and the porch was never warmed', () => {
      expect(run(motion('off'), { [MOTION]: { state: 'off' } })).toMatchObject({ decision: 'no_action', reason: 'motion_cleared_not_warm' });
    });

    it('clamps a hold shorter than the minimum', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [`input_number.${LOCATION}_automation_porch_hold`]: { state: '1' } });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: MIN_HOLD_S * 1000 }]);
    });

    it('clamps a hold longer than the maximum', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [`input_number.${LOCATION}_automation_porch_hold`]: { state: '99999' } });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: MAX_HOLD_S * 1000 }]);
    });

    it('fades back to the snapshot when the hold expires', () => {
      const result = run(timer(HOLD_TIMER), { [MOTION]: { state: 'off' }, [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'restore', reason: 'hold_expired' });
      expect(result.actions).toEqual([restoreCall]);
    });

    it('holds on if the sensor is somehow still on when the hold expires', () => {
      expect(run(timer(HOLD_TIMER), { [PORCH]: warmLook })).toMatchObject({ decision: 'no_action', reason: 'motion_still_on', actions: [] });
    });
  });

  describe('HA restarted during the hold and lost the snapshot', () => {
    const lost = { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [RESTORE]: { state: 'unavailable' } };

    it('turns the porch off with the fade-down when the garden is off', () => {
      const result = run(timer(HOLD_TIMER), { ...lost, [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` } });
      expect(result).toMatchObject({ decision: 'restore', reason: 'hold_expired_snapshot_missing_garden_off' });
      expect(result.actions).toEqual([expect.objectContaining({ service: 'turn_off', target: { entity_id: PORCH }, data: { transition: 5 } })]);
    });

    it('leaves the porch for the next garden scene when the garden is on', () => {
      expect(run(timer(HOLD_TIMER), lost)).toMatchObject({ decision: 'no_action', reason: 'restore_snapshot_missing', actions: [] });
    });

    it('treats a snapshot that never existed the same way', () => {
      const { [RESTORE]: _gone, ...noSnapshot } = base;
      const result = testAutomation(automation, { event: timer(HOLD_TIMER), state: { ...noSnapshot, [MOTION]: { state: 'off' } } as never, ha: makeHa() });
      expect(result).toMatchObject({ reason: 'restore_snapshot_missing' });
    });
  });

  describe('the garden scene changes', () => {
    it('drops the pending fade-back, since the new scene already replaced the warm look', () => {
      const result = run(sceneChange(SPOOKY), { [MOTION]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_changed_hold_dropped' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER)]);
    });

    it('waits for the scene to settle before warming again if someone is still there', () => {
      const result = run(sceneChange(OFF));
      expect(result).toMatchObject({ decision: 'schedule_rewarm', reason: 'scene_changed_during_motion' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), { type: 'timer.start', timerKey: SETTLE_TIMER, delayMs: SCENE_SETTLE_MS }]);
    });

    it('re-snapshots the new look and warms again once settled, so the fade-back lands on the new theme', () => {
      const result = run(timer(SETTLE_TIMER), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } });
      expect(result).toMatchObject({ decision: 'rewarm', reason: 'scene_changed_during_hold' });
      expect(result.actions).toEqual([snapshotCall, warmCall, cancel(HOLD_TIMER)]);
    });

    it('does not rewarm if motion cleared during the settle', () => {
      expect(run(timer(SETTLE_TIMER), { [MOTION]: { state: 'off' } })).toMatchObject({ decision: 'no_action', reason: 'motion_cleared_before_settle' });
    });

    it('ignores a scene reload, which re-reports old activation times', () => {
      const result = run(sceneChange(NORMAL, '2026-10-31T21:00:00+00:00', 'unavailable'));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] });
    });
  });

  describe('someone returns while the porch is fading back', () => {
    const NOW = Date.parse('2026-11-01T21:00:00+00:00');
    const activatedAgo = (ms: number) => ({ [RESTORE]: { state: new Date(NOW - ms).toISOString() } });
    const at = () => vi.useFakeTimers({ now: NOW });

    it('warms again from the existing snapshot instead of snapshotting the half-faded look', () => {
      at();
      const result = run(motion('on'), activatedAgo(2000));
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_during_fade_back' });
      expect(result.actions).toEqual([warmCall, cancel(HOLD_TIMER)]);
    });

    it('does so even at the start of the fade, when the porch still reads warm', () => {
      at();
      const result = run(motion('on'), { ...activatedAgo(300), [PORCH]: warmLook });
      expect(result).toMatchObject({ reason: 'motion_during_fade_back' });
    });

    it('snapshots afresh once the fade and its margin are over', () => {
      at();
      const result = run(motion('on'), activatedAgo(6001));
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected' });
      expect(result.actions[0]).toEqual(snapshotCall);
    });

    it('treats an unparseable or future activation time as not fading', () => {
      at();
      expect(run(motion('on'), { [RESTORE]: { state: 'unknown' } })).toMatchObject({ reason: 'motion_detected' });
      expect(run(motion('on'), { [RESTORE]: { state: 'garbage' } })).toMatchObject({ reason: 'motion_detected' });
      expect(run(motion('on'), activatedAgo(-60_000))).toMatchObject({ reason: 'motion_detected' });
    });
  });

  describe('startup', () => {
    it('leaves the porch as it is until the next garden scene or motion', () => {
      expect(run(onStart)).toMatchObject({ decision: 'no_action', reason: 'startup', actions: [] });
    });
  });

  describe('unexpected or missing inputs', () => {
    it('aborts when no light in the area carries the porch label', () => {
      expect(abortOf(motion('on'), {}, makeHa({ porches: [] })).reason).toBe(`porch_light_not_found:${LOCATION}`);
    });

    it('aborts when the labelled porch is in another area', () => {
      expect(abortOf(motion('on'), {}, makeHa({ porchOutsideArea: true })).reason).toBe(`porch_light_not_found:${LOCATION}`);
    });

    it('aborts when two lights carry the porch label', () => {
      expect(abortOf(motion('on'), {}, makeHa({ porches: [PORCH, OTHER_PORCH] })).reason).toBe(`porch_light_ambiguous:${LOCATION}:2`);
    });

    it('aborts when the porch is unavailable', () => {
      expect(abortOf(motion('on'), { [PORCH]: { state: 'unavailable' } }).reason).toBe(`porch_unavailable:${PORCH}`);
    });

    it('aborts when the motion sensor is unavailable', () => {
      expect(abortOf(timer(HOLD_TIMER), { [MOTION]: { state: 'unavailable' } }).reason).toBe('motion_sensor_unavailable:unavailable');
    });

    it('aborts on a motion event that is neither on nor off', () => {
      expect(abortOf(motion('unavailable')).reason).toBe('motion_event_state_unexpected:unavailable');
    });

    it('aborts when sun.sun is unavailable', () => {
      expect(abortOf(motion('on'), { 'sun.sun': { state: 'unavailable' } }).reason).toBe('sun_unavailable:unavailable');
    });

    it('aborts on a hold helper that is not a number', () => {
      expect(abortOf(motion('off'), { [`input_number.${LOCATION}_automation_porch_hold`]: { state: 'unavailable' } }).reason).toBe(`porch_hold_unavailable:${LOCATION}`);
    });
  });

  describe('configuration', () => {
    it('rejects a restore scene that the garden scene listeners would see', () => {
      expect(() => makePorchLightAutomation({ ...config, restoreSceneId: `${LOCATION}_restore` })).toThrow(/must not start with/);
    });

    it('rejects a non-finite fade', () => {
      expect(() => makePorchLightAutomation({ ...config, fadeUpS: NaN })).toThrow(/finite/);
    });

    it('clamps the warm look to what the bulb supports', () => {
      const wild = makePorchLightAutomation({ ...config, warm: { colorTempKelvin: 50_000, brightness: 900 } });
      const result = run(motion('on'), {}, makeHa(), wild);
      expect(result.actions[1]).toMatchObject({ data: { color_temp_kelvin: 9009, brightness: 255 } });
    });
  });
});
