import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from './declared-outcome.js';
import type { HAContext } from '@ajclarkson/homerun';
import { makePorchLightAutomation, MIN_HOLD_S, MAX_HOLD_S, SCENE_SETTLE_MS } from './porch-light-factory.js';
import { serializeLook, MAX_LOOK_CHARS } from './porch-look.js';

const LOCATION = 'test_garden';
const PORCH = `light.${LOCATION}_light_porch`;
const OTHER_PORCH = `light.${LOCATION}_light_porch_2`;
const MOTION = `binary_sensor.${LOCATION}_sensor_motion_occupancy`;
const HOLD_TIMER = `${LOCATION}:porch_motion_hold`;
const SETTLE_TIMER = `${LOCATION}:porch_scene_settle`;
const NORMAL = `scene.${LOCATION}_all`;
const SPOOKY = `scene.${LOCATION}_spooky`;
const OFF = `scene.${LOCATION}_off`;
const HELPER = `input_text.${LOCATION}_automation_porch_restore`;
const NOW = Date.parse('2026-11-01T21:00:00+00:00');
const FADE_END = NOW + 5000 + 1000;

const WARM = { colorTempKelvin: 2700, brightness: 180 };
const config = { location: LOCATION, warm: WARM, fadeUpS: 2, fadeDownS: 5 };
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

const warmLook = { state: 'on', attributes: { brightness: 180, color_mode: 'color_temp', color_temp_kelvin: 2703 } };
const restingLook = { state: 'on', attributes: { brightness: 90, color_mode: 'color_temp', color_temp_kelvin: 2703 } };
const KELVIN_LOOK = '{"state":"on","brightness":90,"kelvin":2700}';
const base = {
  [PORCH]: restingLook,
  [MOTION]: { state: 'on' },
  'sun.sun': { state: 'below_horizon' },
  [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' },
  [`input_number.${LOCATION}_automation_porch_hold`]: { state: '30' },
  [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_all` },
  [HELPER]: { state: KELVIN_LOOK },
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

const setHelper = (value: string) => ({
  type: 'ha.call_service', domain: 'input_text', service: 'set_value', target: { entity_id: HELPER }, data: { value },
});
// The porch's resting look as the factory reads it from the porch's attributes (2703 K as reported).
const saveCall = setHelper('{"state":"on","brightness":90,"kelvin":2703}');
const lightCall = (service: string, data: Record<string, unknown>) =>
  ({ type: 'ha.call_service', domain: 'light', service, target: { entity_id: PORCH }, data });
const warmCall = expect.objectContaining({
  service: 'turn_on', target: { entity_id: PORCH }, data: { color_temp_kelvin: 2700, brightness: 180, transition: 2 },
});
const markFading = (look: string) => setHelper(look.replace(/}$/, `,"fadeEndsMs":${FADE_END}}`));
const restoreActions = [
  markFading(KELVIN_LOOK),
  lightCall('turn_on', { brightness: 90, color_temp_kelvin: 2700, transition: 5 }),
];
const cancel = (timerKey: string) => ({ type: 'timer.cancel', timerKey });

afterEach(() => vi.useRealTimers());

beforeEach(() => vi.useFakeTimers({ now: NOW }));

describe('Porch light on motion', () => {
  describe('someone arrives in the dark', () => {
    it('saves the porch look in the helper, then fades to the warm look, in that order', () => {
      const result = run(motion('on'), { [MOTION]: { state: 'on' } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected', outcome: 'acted' });
      expect(result.actions).toEqual([saveCall, warmCall, cancel(HOLD_TIMER)]);
    });

    it('warms in every theme when no theme opts out', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected', outcome: 'acted' });
    });

    it('warms after the garden has turned off for the night', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` }, [PORCH]: { state: 'off', attributes: {} } });
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected', outcome: 'acted' });
    });

    it('warms when no scene has been active yet', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: 'unknown' } });
      expect(result).toMatchObject({ decision: 'warm' });
    });
  });

  describe('when it should stay quiet', () => {
    it('ignores motion in daylight', () => {
      expect(run(motion('on'), { 'sun.sun': { state: 'above_horizon' } })).toMatchObject({ decision: 'no_action', reason: 'daylight', outcome: 'ignored', actions: [] });
    });

    it('ignores motion while a theme that opted out is showing', () => {
      const result = run(motion('on'), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } }, makeHa(), optOut);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'theme_opted_out', outcome: 'declined', actions: [] });
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
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled_idle', outcome: 'ignored' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER)]);
    });

    it('puts the porch back if the automation is switched off while it is warm', () => {
      const result = run(motion('off'), { [PORCH]: warmLook, [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'restore', reason: 'automation_disabled_restore', outcome: 'acted' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER), ...restoreActions]);
    });
  });

  describe('someone keeps moving about', () => {
    it('stays warm without saving the look a second time, and cancels the fade-back', () => {
      const result = run(motion('on'), { [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'already_warm', outcome: 'ignored' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER)]);
    });

    it('does not mistake the resting look for the warm look', () => {
      expect(run(motion('on'), { [PORCH]: { state: 'on', attributes: { brightness: 180, color_mode: 'color_temp', color_temp_kelvin: 4000 } } })).toMatchObject({ decision: 'warm' });
    });
  });

  describe('someone leaves', () => {
    it('starts the hold from the helper when motion clears while warm', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'hold', reason: 'motion_cleared', outcome: 'ignored' });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: 30_000 }]);
    });

    it('does nothing when motion clears and the porch was never warmed', () => {
      expect(run(motion('off'), { [MOTION]: { state: 'off' } })).toMatchObject({ decision: 'no_action', reason: 'motion_cleared_not_warm', outcome: 'ignored' });
    });

    it('clamps a hold shorter than the minimum', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [`input_number.${LOCATION}_automation_porch_hold`]: { state: '1' } });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: MIN_HOLD_S * 1000 }]);
    });

    it('clamps a hold longer than the maximum', () => {
      const result = run(motion('off'), { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [`input_number.${LOCATION}_automation_porch_hold`]: { state: '99999' } });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: HOLD_TIMER, delayMs: MAX_HOLD_S * 1000 }]);
    });

    it('fades back to the saved look when the hold expires', () => {
      const result = run(timer(HOLD_TIMER), { [MOTION]: { state: 'off' }, [PORCH]: warmLook });
      expect(result).toMatchObject({ decision: 'restore', reason: 'hold_expired', outcome: 'acted' });
      expect(result.actions).toEqual(restoreActions);
    });

    it('holds on if the sensor is somehow still on when the hold expires', () => {
      expect(run(timer(HOLD_TIMER), { [PORCH]: warmLook })).toMatchObject({ decision: 'no_action', reason: 'motion_still_on', outcome: 'ignored', actions: [] });
    });
  });

  describe('the saved look is missing or garbled at hold expiry', () => {
    const lost = { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [HELPER]: { state: '' } };

    it('turns the porch off with the fade-down when the garden is off', () => {
      const result = run(timer(HOLD_TIMER), { ...lost, [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_off` } });
      expect(result).toMatchObject({ decision: 'restore', reason: 'hold_expired_look_missing_garden_off', outcome: 'acted' });
      expect(result.actions).toEqual([expect.objectContaining({ service: 'turn_off', target: { entity_id: PORCH }, data: { transition: 5 } })]);
    });

    it.each(['not json', '{"state":"on"}', '{"state":"on","brightness":90}', '{"state":"on","brightness":null,"kelvin":2700}', '[1]', 'null'])(
      'treats %s as no saved look', (junk) => {
        expect(run(timer(HOLD_TIMER), { ...lost, [HELPER]: { state: junk } })).toMatchObject({ reason: 'restore_look_missing', outcome: 'declined' });
      });

    it('leaves the porch for the next garden scene when the garden is on', () => {
      expect(run(timer(HOLD_TIMER), lost)).toMatchObject({ decision: 'no_action', reason: 'restore_look_missing', outcome: 'declined', actions: [] });
    });

    it('treats a helper holding nothing the same way', () => {
      expect(run(timer(HOLD_TIMER), { [MOTION]: { state: 'off' }, [HELPER]: { state: 'unknown' } })).toMatchObject({ reason: 'restore_look_missing', outcome: 'declined' });
    });
  });

  describe('the garden scene changes', () => {
    it('drops the pending fade-back, since the new scene already replaced the warm look', () => {
      const result = run(sceneChange(SPOOKY), { [MOTION]: { state: 'off' } });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_changed_hold_dropped', outcome: 'ignored' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), cancel(SETTLE_TIMER)]);
    });

    it('waits for the scene to settle before warming again if someone is still there', () => {
      const result = run(sceneChange(OFF));
      expect(result).toMatchObject({ decision: 'schedule_rewarm', reason: 'scene_changed_during_motion', outcome: 'ignored' });
      expect(result.actions).toEqual([cancel(HOLD_TIMER), { type: 'timer.start', timerKey: SETTLE_TIMER, delayMs: SCENE_SETTLE_MS }]);
    });

    it('saves the new look and warms again once settled, so the fade-back lands on the new theme', () => {
      const result = run(timer(SETTLE_TIMER), { [`sensor.${LOCATION}_active_scene`]: { state: `${LOCATION}_spooky` } });
      expect(result).toMatchObject({ decision: 'rewarm', reason: 'scene_changed_during_hold', outcome: 'acted' });
      expect(result.actions).toEqual([saveCall, warmCall, cancel(HOLD_TIMER)]);
    });

    it('does not rewarm if motion cleared during the settle', () => {
      expect(run(timer(SETTLE_TIMER), { [MOTION]: { state: 'off' } })).toMatchObject({ decision: 'no_action', reason: 'motion_cleared_before_settle', outcome: 'ignored' });
    });

    it('ignores a scene reload, which re-reports old activation times', () => {
      const result = run(sceneChange(NORMAL, '2026-10-31T21:00:00+00:00', 'unavailable'));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated', outcome: 'ignored', actions: [] });
    });
  });

  describe('looks are saved and restored faithfully', () => {
    const expiredWith = (look: string, ha = makeHa()) => run(timer(HOLD_TIMER), { [MOTION]: { state: 'off' }, [PORCH]: warmLook, [HELPER]: { state: look } }, ha);

    it('restores a colour-temperature look with kelvin', () => {
      expect(expiredWith('{"state":"on","brightness":120,"kelvin":3000}').actions[1])
        .toEqual(lightCall('turn_on', { brightness: 120, color_temp_kelvin: 3000, transition: 5 }));
    });

    it('restores a coloured look with xy and never an effect', () => {
      const action = expiredWith('{"state":"on","brightness":90,"xy":[0.208,0.079]}').actions[1];
      expect(action).toEqual(lightCall('turn_on', { brightness: 90, xy_color: [0.208, 0.079], transition: 5 }));
      expect(JSON.stringify(action)).not.toContain('effect');
    });

    it('restores an off look by fading the porch out', () => {
      expect(expiredWith('{"state":"off"}').actions[1]).toEqual(lightCall('turn_off', { transition: 5 }));
    });

    it('clamps out-of-range saved values before emitting them', () => {
      expect(expiredWith('{"state":"on","brightness":900,"xy":[2,-1]}').actions[1])
        .toEqual(lightCall('turn_on', { brightness: 255, xy_color: [1, 0], transition: 5 }));
    });

    it('saves a coloured porch as xy when motion arrives', () => {
      const coloured = { state: 'on', attributes: { brightness: 90, color_mode: 'xy', xy_color: [0.208, 0.079], color_temp_kelvin: 2000, effect: 'candlelight' } };
      const result = run(motion('on'), { [PORCH]: coloured });
      expect(result.actions[0]).toEqual(setHelper('{"state":"on","brightness":90,"xy":[0.208,0.079]}'));
    });

    it('saves an off porch as off', () => {
      expect(run(motion('on'), { [PORCH]: { state: 'off', attributes: {} } }).actions[0]).toEqual(setHelper('{"state":"off"}'));
    });

    it.each([
      ['no brightness', { color_mode: 'color_temp', color_temp_kelvin: 2700 }, 'porch_brightness_missing'],
      ['a non-finite brightness', { brightness: NaN, color_mode: 'color_temp', color_temp_kelvin: 2700 }, 'porch_brightness_missing'],
      ['no kelvin', { brightness: 90, color_mode: 'color_temp' }, 'porch_kelvin_missing'],
      ['no xy', { brightness: 90, color_mode: 'xy' }, 'porch_xy_missing'],
    ])('warms nothing and says why when the porch is on with %s', (_name, attributes, problem) => {
      const result = run(motion('on'), { [PORCH]: { state: 'on', attributes } });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'look_unreadable', outcome: 'declined', facts: { problem }, actions: [] });
    });

    it('keeps every saved look, with its fade marker, within the helper limit', () => {
      const long = serializeLook({ state: 'on', brightness: 255, xy: [0.123456789012345, 0.987654321098765] }, 1_999_999_999_999);
      expect(long.length).toBeLessThanOrEqual(MAX_LOOK_CHARS);
    });

    it('refuses to write a look longer than the helper holds', () => {
      expect(() => serializeLook({ state: 'on', brightness: 90, kelvin: 2700, pad: 'x'.repeat(300) } as never)).toThrow(/over 255/);
    });
  });

  describe('someone returns while the porch is fading back', () => {
    const fading = { [HELPER]: { state: `{"state":"on","brightness":90,"kelvin":2700,"fadeEndsMs":${FADE_END}}` } };
    const at = (msAfterRestore: number) => vi.setSystemTime(NOW + msAfterRestore);

    it('warms again keeping the saved look, instead of saving the half-faded look', () => {
      at(2000);
      const result = run(motion('on'), fading);
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_during_fade_back', outcome: 'acted' });
      expect(result.actions).toEqual([setHelper(KELVIN_LOOK), warmCall, cancel(HOLD_TIMER)]);
    });

    it('does so even at the start of the fade, when the porch still reads warm', () => {
      at(300);
      expect(run(motion('on'), { ...fading, [PORCH]: warmLook })).toMatchObject({ reason: 'motion_during_fade_back', outcome: 'acted' });
    });

    it('saves the current look afresh once the fade and its margin are over', () => {
      at(6001);
      const result = run(motion('on'), fading);
      expect(result).toMatchObject({ decision: 'warm', reason: 'motion_detected', outcome: 'acted' });
      expect(result.actions[0]).toEqual(saveCall);
    });

    it('treats a marker that is absent, garbage or implausibly far ahead as not fading', () => {
      at(2000);
      expect(run(motion('on'))).toMatchObject({ reason: 'motion_detected', outcome: 'acted' });
      expect(run(motion('on'), { [HELPER]: { state: 'garbage' } })).toMatchObject({ reason: 'motion_detected', outcome: 'acted' });
      expect(run(motion('on'), { [HELPER]: { state: `{"state":"on","brightness":90,"kelvin":2700,"fadeEndsMs":${NOW + 3_600_000}}` } })).toMatchObject({ reason: 'motion_detected', outcome: 'acted' });
    });

    it('forgets the fade marker when a garden scene takes over mid-fade, so the next motion saves the scene look', () => {
      at(2000);
      const result = run(sceneChange(SPOOKY), { ...fading, [MOTION]: { state: 'off' } });
      expect(result.actions).toEqual([setHelper(KELVIN_LOOK), cancel(HOLD_TIMER), cancel(SETTLE_TIMER)]);
    });
  });

  describe('startup', () => {
    it('leaves the porch as it is until the next garden scene or motion', () => {
      expect(run(onStart)).toMatchObject({ decision: 'no_action', reason: 'startup', outcome: 'ignored', actions: [] });
    });
  });

  describe('unexpected or missing inputs', () => {
    it('aborts when the restore helper does not exist', () => {
      const { [HELPER]: _gone, ...rest } = base;
      const r = testAbort(automation, { event: motion('on'), state: rest as never, ha: makeHa() });
      expect(r.reason).toBe(`porch_restore_helper_unavailable:${HELPER}`);
    });

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
