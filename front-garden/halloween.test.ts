import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import automation, {
  TIMERS, DRIFT_COLOURS, DRIFT_PERIOD_MS, DRIFT_TRANSITION_S, LIGHTNING_MIN_GAP_MS, LIGHTNING_MAX_GAP_MS,
  FLICKER_MS, FLICKER_TO_FLASH_MS, FLASH_MS, ECHO_AFTER_MS,
} from './halloween.js';

const BIRCH = 'light.front_garden_light_birch';
const BIRCH_2 = 'light.front_garden_light_birch_2';
const MAPLE = 'light.front_garden_light_maple';
const HALLOWEEN = 'scene.front_garden_halloween';
const NORMAL = 'scene.front_garden_all';
const OFF = 'scene.front_garden_off';
const [PURPLE, GREEN] = DRIFT_COLOURS;

function makeHa(opts: { secondBirch?: boolean; noFeature?: boolean; noHalloweenScene?: boolean } = {}): Partial<HAContext> {
  const feature = opts.noFeature ? [] : [BIRCH, ...(opts.secondBirch ? [BIRCH_2] : [])];
  const area = [...feature, MAPLE, HALLOWEEN, NORMAL, OFF];
  const labelMap: Record<string, string[]> = {
    outdoor_light_feature: ['light.back_garden_light_tree', ...feature],
    outdoor_light_accent: [MAPLE],
    scene_theme_halloween: ['scene.back_garden_halloween', ...(opts.noHalloweenScene ? [] : [HALLOWEEN])],
    scene_control_off: [OFF],
  };
  return {
    entitiesByArea: (a) => (a === 'front_garden' ? area : ['light.back_garden_light_tree', 'scene.back_garden_halloween']),
    entitiesByLabel: (label) => labelMap[label] ?? [],
  };
}

const enabled = { 'input_boolean.front_garden_automation_lights_enabled': { state: 'on' } };
const disabled = { 'input_boolean.front_garden_automation_lights_enabled': { state: 'off' } };
const active = (scene: string) => ({ 'sensor.front_garden_active_scene': { state: scene.replace('scene.', '') } });
const halloweenOn = active(HALLOWEEN);

function sceneActivated(scene: string, newState = '2026-10-31T17:00:00.000+00:00', oldState = '2026-10-30T17:00:00.000+00:00') {
  return {
    type: 'state_changed' as const,
    entity_id: scene,
    old_state: { entity_id: scene, state: oldState, attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: scene, state: newState, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}
const timer = (timerKey: string) => ({ type: 'timer_expired' as const, timerKey, correlation_id: 'test-cid' });
const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };

type AnyEvent = ReturnType<typeof sceneActivated> | ReturnType<typeof timer> | typeof onStart;

function run(event: AnyEvent, state: Record<string, { state: string }> = {}, ha = makeHa()) {
  return testAutomation(automation, { event, state: { ...enabled, ...state }, ha });
}

// Local wall-clock time on Halloween, nudged onto a drift period of the requested colour.
function clockAt(time: string, colour: 'purple' | 'green' = 'purple', msIntoPeriod = 10_000) {
  const [h, m] = time.split(':').map(Number);
  const base = new Date(2026, 9, 31, h, m).getTime();
  const cycle = DRIFT_PERIOD_MS * DRIFT_COLOURS.length;
  const periodStart = base - (base % cycle) + (colour === 'purple' ? 0 : DRIFT_PERIOD_MS);
  vi.setSystemTime(periodStart + msIntoPeriod);
}

const lightCall = (entity_id: string, rgb_color: number[], brightness: number, transition: number) =>
  expect.objectContaining({ service: 'turn_on', target: { entity_id }, data: { rgb_color, brightness, transition } });
const timerStart = (timerKey: string, delayMs: number) => ({ type: 'timer.start', timerKey, delayMs });
const cancelAll = Object.values(TIMERS).map(timerKey => ({ type: 'timer.cancel', timerKey }));
const targets = (actions: unknown[]) =>
  actions.map(a => (a as { target?: { entity_id: string } }).target?.entity_id).filter(Boolean);

beforeEach(() => {
  vi.useFakeTimers();
  clockAt('18:00');
  vi.spyOn(Math, 'random').mockReturnValue(0.5);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const midGap = LIGHTNING_MIN_GAP_MS + Math.floor(0.5 * (LIGHTNING_MAX_GAP_MS - LIGHTNING_MIN_GAP_MS));

describe('Halloween animation', () => {
  describe('starting', () => {
    it('starts the drift at the next colour change and queues the first lightning strike when the Halloween scene is applied', () => {
      clockAt('18:00', 'purple', 10_000);
      const result = run(sceneActivated(HALLOWEEN), halloweenOn);
      expect(result).toMatchObject({ decision: 'start_animation', reason: 'halloween_scene_activated' });
      expect(result.actions).toEqual([
        ...cancelAll,
        timerStart(TIMERS.drift, DRIFT_PERIOD_MS - 10_000 + 500),
        timerStart(TIMERS.strike, midGap),
      ]);
    });

    it('restarts cleanly if the Halloween button is pressed again', () => {
      const result = run(sceneActivated(HALLOWEEN), halloweenOn);
      expect(result.actions.slice(0, cancelAll.length)).toEqual(cancelAll);
    });

    it('picks the animation back up after a restart while Halloween is showing', () => {
      const result = run(onStart, halloweenOn);
      expect(result).toMatchObject({ decision: 'start_animation', reason: 'startup_with_halloween_active' });
    });

    it('starts with drift only once lightning hours are over', () => {
      clockAt('21:00');
      const result = run(sceneActivated(HALLOWEEN), halloweenOn);
      expect(result.actions).not.toContainEqual(expect.objectContaining({ timerKey: TIMERS.strike, type: 'timer.start' }));
      expect(result.actions).toContainEqual(expect.objectContaining({ timerKey: TIMERS.drift, type: 'timer.start' }));
    });

    it('does nothing after a restart when Halloween is not showing', () => {
      expect(run(onStart, active(NORMAL))).toMatchObject({ decision: 'no_action', reason: 'halloween_not_active' });
    });
  });

  describe('drift', () => {
    it('fades the birch to green on a green period, then holds it until the next change', () => {
      clockAt('18:30', 'green', 500);
      const result = run(timer(TIMERS.drift), halloweenOn);
      expect(result).toMatchObject({ decision: 'drift', reason: 'drift_to_green' });
      expect(result.actions).toEqual([
        lightCall(BIRCH, GREEN.rgb, GREEN.brightness, DRIFT_TRANSITION_S),
        timerStart(TIMERS.drift, DRIFT_PERIOD_MS - 500 + 500),
      ]);
    });

    it('fades back to purple on the following period', () => {
      clockAt('18:31', 'purple', 500);
      const result = run(timer(TIMERS.drift), halloweenOn);
      expect(result).toMatchObject({ reason: 'drift_to_purple' });
      expect(result.actions[0]).toEqual(lightCall(BIRCH, PURPLE.rgb, PURPLE.brightness, DRIFT_TRANSITION_S));
    });

    it('holds each colour for most of its period rather than fading continuously', () => {
      expect(DRIFT_TRANSITION_S * 1000).toBeLessThanOrEqual(DRIFT_PERIOD_MS / 2);
    });

    it('starts from the same purple as the Halloween scene, so the first fade is seamless', () => {
      expect(PURPLE.rgb).toEqual([120, 30, 255]);
      expect(PURPLE.brightness).toBe(220);
    });

    it('drives every birch light together', () => {
      clockAt('18:30', 'green', 500);
      const result = run(timer(TIMERS.drift), halloweenOn, makeHa({ secondBirch: true }));
      expect(targets(result.actions)).toEqual([BIRCH, BIRCH_2]);
    });
  });

  describe('lightning', () => {
    it('opens with a short dim flicker that drops back to the drift colour', () => {
      clockAt('19:00', 'purple');
      const flicker = run(timer(TIMERS.strike), halloweenOn);
      expect(flicker).toMatchObject({ decision: 'lightning_flicker' });
      expect(flicker.actions).toEqual([
        lightCall(BIRCH, [200, 215, 255], 110, 0),
        timerStart(TIMERS.flickerEnd, FLICKER_MS),
      ]);

      const flickerEnd = run(timer(TIMERS.flickerEnd), halloweenOn);
      expect(flickerEnd).toMatchObject({ decision: 'lightning_flicker_end' });
      expect(flickerEnd.actions).toEqual([
        lightCall(BIRCH, PURPLE.rgb, PURPLE.brightness, 0),
        timerStart(TIMERS.flash, FLICKER_TO_FLASH_MS - FLICKER_MS),
      ]);
    });

    it('follows with a short full-brightness flash, a beat after the flicker began', () => {
      const flash = run(timer(TIMERS.flash), halloweenOn);
      expect(flash).toMatchObject({ decision: 'lightning_flash' });
      expect(flash.actions).toEqual([
        lightCall(BIRCH, [200, 215, 255], 255, 0),
        timerStart(TIMERS.restore, FLASH_MS),
      ]);
    });

    it('keeps the tuned rhythm: ~100ms flicker, flash ~350ms after it began, ~120ms flash', () => {
      expect([FLICKER_MS, FLICKER_TO_FLASH_MS, FLASH_MS]).toEqual([100, 350, 120]);
    });

    describe('each bolt is a pair of strikes', () => {
      it('snaps back after the first strike and queues its echo to start 5s after the first began', () => {
        clockAt('19:00', 'green');
        const result = run(timer(TIMERS.restore), halloweenOn);
        expect(result).toMatchObject({ decision: 'lightning_restore', reason: 'echo_scheduled' });
        expect(result.actions).toEqual([
          lightCall(BIRCH, GREEN.rgb, GREEN.brightness, 0),
          timerStart(TIMERS.echo, ECHO_AFTER_MS - FLICKER_TO_FLASH_MS - FLASH_MS),
        ]);
        expect(ECHO_AFTER_MS).toBe(5_000);
      });

      it('runs the echo with the same flicker-then-flash rhythm on its own steps', () => {
        clockAt('19:00', 'purple');
        expect(run(timer(TIMERS.echo), halloweenOn)).toMatchObject({ decision: 'lightning_flicker', reason: 'lightning_echo' });
        expect(run(timer(TIMERS.echo), halloweenOn).actions).toEqual([
          lightCall(BIRCH, [200, 215, 255], 110, 0),
          timerStart(TIMERS.echoFlickerEnd, FLICKER_MS),
        ]);
        expect(run(timer(TIMERS.echoFlickerEnd), halloweenOn).actions).toEqual([
          lightCall(BIRCH, PURPLE.rgb, PURPLE.brightness, 0),
          timerStart(TIMERS.echoFlash, FLICKER_TO_FLASH_MS - FLICKER_MS),
        ]);
        expect(run(timer(TIMERS.echoFlash), halloweenOn).actions).toEqual([
          lightCall(BIRCH, [200, 215, 255], 255, 0),
          timerStart(TIMERS.echoRestore, FLASH_MS),
        ]);
      });

      it('after the echo, snaps back and queues the next bolt 5–10 minutes out', () => {
        clockAt('19:00', 'green');
        const result = run(timer(TIMERS.echoRestore), halloweenOn);
        expect(result).toMatchObject({ decision: 'lightning_restore', reason: 'next_bolt_scheduled' });
        expect(result.actions).toEqual([lightCall(BIRCH, GREEN.rgb, GREEN.brightness, 0), timerStart(TIMERS.strike, midGap)]);
      });

      it.each([
        [0, LIGHTNING_MIN_GAP_MS],
        [0.999999, LIGHTNING_MAX_GAP_MS - 1],
      ])('keeps the gap between bolts within 5–10 minutes (random %s)', (random, expected) => {
        vi.spyOn(Math, 'random').mockReturnValue(random);
        const result = run(timer(TIMERS.echoRestore), halloweenOn);
        expect(result.actions).toContainEqual(timerStart(TIMERS.strike, expected));
        expect(expected).toBeGreaterThanOrEqual(5 * 60_000);
        expect(expected).toBeLessThan(10 * 60_000);
      });
    });

    describe('at the 20:30 cutoff', () => {
      it('starts no new bolt', () => {
        clockAt('20:30');
        const result = run(timer(TIMERS.strike), halloweenOn);
        expect(result).toMatchObject({ decision: 'no_action', reason: 'past_lightning_cutoff' });
        expect(result.actions).toEqual([]);
      });

      it('still lets a bolt that began just before 20:30 finish with its echo', () => {
        clockAt('20:30');
        expect(run(timer(TIMERS.restore), halloweenOn).actions).toContainEqual(expect.objectContaining({ timerKey: TIMERS.echo }));
        expect(run(timer(TIMERS.echo), halloweenOn)).toMatchObject({ decision: 'lightning_flicker', reason: 'lightning_echo' });
      });

      it('queues nothing after that final echo', () => {
        clockAt('20:30');
        const result = run(timer(TIMERS.echoRestore), halloweenOn);
        expect(result).toMatchObject({ decision: 'lightning_restore', reason: 'past_lightning_cutoff' });
        expect(result.actions).toHaveLength(1);
      });
    });

    it('never flashes the maple, which sits beside the street light', () => {
      for (const key of Object.values(TIMERS)) {
        expect(targets(run(timer(key), halloweenOn).actions)).not.toContain(MAPLE);
      }
    });
  });

  describe('stopping', () => {
    it.each([
      ['the garden turning off', OFF],
      ['another look being chosen', NORMAL],
    ])('stops and cancels every pending step on %s', (_name, scene) => {
      const result = run(sceneActivated(scene), active(scene));
      expect(result).toMatchObject({ decision: 'stop_animation', reason: 'other_scene_activated' });
      expect(result.actions).toEqual(cancelAll);
    });

    it.each(Object.values(TIMERS))(
      'a %s step arriving after the garden has turned off never relights it',
      (key) => {
        const result = run(timer(key), active(OFF));
        expect(result).toMatchObject({ decision: 'stop_animation', reason: 'halloween_no_longer_active' });
        expect(result.actions).toEqual(cancelAll);
      },
    );

    it('stops the animation if automatic lights are switched off mid-evening', () => {
      const result = run(timer(TIMERS.drift), { ...halloweenOn, ...disabled });
      expect(result).toMatchObject({ decision: 'stop_animation', reason: 'automation_disabled' });
      expect(result.actions).toEqual(cancelAll);
    });

    it('does not start when automatic lights are switched off', () => {
      const result = run(sceneActivated(HALLOWEEN), { ...halloweenOn, ...disabled });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('robustness', () => {
    it('ignores a scenes reload restoring the theme scene\'s old activation time (e.g. a scenes.yaml deploy)', () => {
      const result = run(sceneActivated(HALLOWEEN, '2026-10-16T17:44:56.718279+00:00', 'unavailable'), halloweenOn);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated' });
      expect(result.actions).toEqual([]);
    });

    it("still reacts to a scene's first ever activation", () => {
      const result = run(sceneActivated(HALLOWEEN, '2026-10-31T17:00:00.000+00:00', 'unknown'), halloweenOn);
      expect(result.decision).not.toBe('no_action');
    });

    it.each(['unavailable', 'unknown'])('ignores scenes passing through %s while HA reloads them', (s) => {
      const result = run(sceneActivated(HALLOWEEN, s), halloweenOn);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated' });
    });

    it('stays quiet and stops when no lights carry the feature role', () => {
      const result = run(sceneActivated(HALLOWEEN), halloweenOn, makeHa({ noFeature: true }));
      expect(result).toMatchObject({ decision: 'stop_animation', reason: 'no_feature_lights' });
      expect(targets(result.actions)).toEqual([]);
    });

    it("never animates another area's lights, even with the same role label", () => {
      expect(targets(run(timer(TIMERS.flash), halloweenOn).actions)).not.toContain('light.back_garden_light_tree');
    });

    it('does not mistake another garden\'s Halloween scene for this one', () => {
      const result = run(sceneActivated('scene.back_garden_halloween'), active(NORMAL));
      expect(result.decision).not.toBe('start_animation');
    });

    it('does not run when the Halloween scene is not labelled for this garden', () => {
      const result = run(sceneActivated(HALLOWEEN), halloweenOn, makeHa({ noHalloweenScene: true }));
      expect(result.decision).not.toBe('start_animation');
    });
  });
});
