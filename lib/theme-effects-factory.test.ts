import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import { makeThemeEffectsAutomation, EFFECTS_SETTLE_MS } from './theme-effects-factory.js';

const LOCATION = 'test_garden';
const SETTLE_TIMER = `${LOCATION}:theme_effects_settle`;
const FEATURE = `light.${LOCATION}_light_tree`;
const FEATURE_2 = `light.${LOCATION}_light_tree_2`;
const ACCENT = `light.${LOCATION}_light_hedge`;
const NORMAL_SCENE = `scene.${LOCATION}_all`;
const OFF_SCENE = `scene.${LOCATION}_off`;
const SPOOKY_SCENE = `scene.${LOCATION}_spooky`;
const COSY_SCENE = `scene.${LOCATION}_cosy`;
const FESTIVE_SCENE = `scene.${LOCATION}_festive`;

const automation = makeThemeEffectsAutomation({
  location: LOCATION,
  themes: {
    spooky: { accent: 'fireplace' },
    festive: { feature: 'sparkle', accent: 'candle' },
  },
});

// Area holds the lights and scenes; another area has identically-labelled lights and scenes
// to prove everything is area-scoped. 'cosy' is a theme scene with no effects configured.
function makeHa(opts: { withoutAccent?: boolean; secondFeature?: boolean } = {}): Partial<HAContext> {
  const area = [
    FEATURE, ...(opts.secondFeature ? [FEATURE_2] : []), ...(opts.withoutAccent ? [] : [ACCENT]),
    NORMAL_SCENE, OFF_SCENE, SPOOKY_SCENE, COSY_SCENE, FESTIVE_SCENE,
  ];
  const labelMap: Record<string, string[]> = {
    outdoor_light_feature: ['light.elsewhere_tree', FEATURE, ...(opts.secondFeature ? [FEATURE_2] : [])],
    outdoor_light_accent: ['light.elsewhere_hedge', ...(opts.withoutAccent ? [] : [ACCENT])],
    scene_order_1: [NORMAL_SCENE],
    scene_control_off: ['scene.elsewhere_off', OFF_SCENE],
    scene_theme_spooky: ['scene.elsewhere_spooky', SPOOKY_SCENE],
    scene_theme_cosy: [COSY_SCENE],
    scene_theme_festive: [FESTIVE_SCENE],
  };
  return {
    entitiesByArea: (a) => (a === LOCATION ? area : ['light.elsewhere_tree', 'light.elsewhere_hedge', 'scene.elsewhere_off', 'scene.elsewhere_spooky']),
    entitiesByLabel: (label) => labelMap[label] ?? [],
  };
}

const enabled = { [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' } };
const disabled = { [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } };
const activeScene = (scene: string) => ({ [`sensor.${LOCATION}_active_scene`]: { state: scene.replace('scene.', '') } });

function sceneActivated(scene: string, newState = '2026-10-31T18:00:00.000+00:00', oldState = '2026-10-30T17:00:00.000+00:00') {
  return {
    type: 'state_changed' as const,
    entity_id: scene,
    old_state: { entity_id: scene, state: oldState, attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: scene, state: newState, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}
const settled = { type: 'timer_expired' as const, timerKey: SETTLE_TIMER, correlation_id: 'test-cid' };
const onStart = { type: 'on_start' as const, correlation_id: 'test-cid' };

type AnyEvent = ReturnType<typeof sceneActivated> | typeof settled | typeof onStart;

function run(event: AnyEvent, state: Record<string, { state: string }> = {}, ha = makeHa()) {
  return testAutomation(automation, { event, state: { ...enabled, ...state }, ha });
}

const effectCall = (entity_id: string, effect: string) =>
  expect.objectContaining({ service: 'turn_on', target: { entity_id }, data: expect.objectContaining({ effect }) });

describe('theme effects', () => {
  describe("when a theme's scene is activated", () => {
    it('waits for the scene to settle before starting effects, so its colours do not overwrite them', () => {
      const result = run(sceneActivated(SPOOKY_SCENE));
      expect(result).toMatchObject({ decision: 'schedule_effects', reason: 'theme_scene_activated' });
      expect(result.actions).toEqual([{ type: 'timer.start', timerKey: SETTLE_TIMER, delayMs: EFFECTS_SETTLE_MS }]);
    });

    it("then starts each role's configured effect on the lights in that role", () => {
      const result = run(settled, activeScene(SPOOKY_SCENE));
      expect(result).toMatchObject({ decision: 'start_effects', reason: 'theme_scene_settled' });
      expect(result.actions).toEqual([effectCall(ACCENT, 'fireplace')]);
    });

    it('starts effects for every role a theme configures', () => {
      const result = run(settled, activeScene(FESTIVE_SCENE));
      expect(result.actions).toEqual([effectCall(FEATURE, 'sparkle'), effectCall(ACCENT, 'candle')]);
    });

    it('starts the effect on every light sharing a role', () => {
      const result = run(settled, activeScene(FESTIVE_SCENE), makeHa({ secondFeature: true }));
      expect(result.actions).toEqual([effectCall(FEATURE, 'sparkle'), effectCall(FEATURE_2, 'sparkle'), effectCall(ACCENT, 'candle')]);
    });

    it('does nothing if the scene has changed again by the time it settles', () => {
      const result = run(settled, activeScene(NORMAL_SCENE));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'no_effects_theme_active' });
      expect(result.actions).toEqual([]);
    });

    it('reports a misconfiguration rather than acting when no lights carry the theme roles', () => {
      const result = run(settled, activeScene(SPOOKY_SCENE), makeHa({ withoutAccent: true }));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'no_lights_in_theme_roles' });
    });
  });

  describe('when the garden moves to a look without effects', () => {
    it('clears any running effect from every themed light and drops a pending start', () => {
      const result = run(sceneActivated(NORMAL_SCENE));
      expect(result).toMatchObject({ decision: 'stop_effects', reason: 'scene_without_effects_activated' });
      expect(result.actions).toEqual([
        { type: 'timer.cancel', timerKey: SETTLE_TIMER },
        effectCall(FEATURE, 'stop_hue_effect'),
        effectCall(ACCENT, 'stop_hue_effect'),
      ]);
    });

    it('treats a theme scene with no effects configured the same way', () => {
      const result = run(sceneActivated(COSY_SCENE));
      expect(result).toMatchObject({ decision: 'stop_effects' });
    });
  });

  describe('when the garden turns off', () => {
    it('only drops a pending start, since effects end with the lights', () => {
      const result = run(sceneActivated(OFF_SCENE));
      expect(result).toMatchObject({ decision: 'cancel_effects', reason: 'off_scene_activated' });
      expect(result.actions).toEqual([{ type: 'timer.cancel', timerKey: SETTLE_TIMER }]);
    });
  });

  describe('after a restart', () => {
    it("re-applies the active theme's effects", () => {
      const result = run(onStart, activeScene(SPOOKY_SCENE));
      expect(result).toMatchObject({ decision: 'start_effects', reason: 'startup_with_theme_active' });
      expect(result.actions).toEqual([effectCall(ACCENT, 'fireplace')]);
    });

    it('does nothing when the active scene has no effects', () => {
      expect(run(onStart, activeScene(NORMAL_SCENE))).toMatchObject({ decision: 'no_action', reason: 'no_effects_theme_active' });
    });

    it('does nothing when the active scene is unknown', () => {
      expect(run(onStart, { [`sensor.${LOCATION}_active_scene`]: { state: 'unknown' } })).toMatchObject({ decision: 'no_action' });
    });
  });

  describe('when HA reloads its scenes', () => {
    it('ignores a scenes reload restoring the theme scene\'s old activation time (e.g. a scenes.yaml deploy)', () => {
      const result = run(sceneActivated(SPOOKY_SCENE, '2026-10-16T17:44:56.718279+00:00', 'unavailable'));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated' });
      expect(result.actions).toEqual([]);
    });

    it("still reacts to a scene's first ever activation", () => {
      const result = run(sceneActivated(SPOOKY_SCENE, '2026-10-31T17:00:00.000+00:00', 'unknown'));
      expect(result.decision).not.toBe('no_action');
    });

    it.each(['unavailable', 'unknown'])('ignores the scene passing through %s, which is not an activation', (s) => {
      const result = run(sceneActivated(NORMAL_SCENE, s));
      expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('when automatic lights are switched off for the garden', () => {
    it.each([
      ['a theme scene activating', sceneActivated(SPOOKY_SCENE), {}],
      ['a theme scene settling', settled, activeScene(SPOOKY_SCENE)],
      ['a restart', onStart, activeScene(SPOOKY_SCENE)],
    ] as const)('leaves the lights alone on %s', (_name, event, state) => {
      const result = run(event, { ...state, ...disabled });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('scoping', () => {
    it("never touches another area's lights, even with the same role labels", () => {
      const result = run(settled, activeScene(FESTIVE_SCENE));
      const targets = result.actions.map((a: unknown) => (a as { target?: { entity_id: string } }).target?.entity_id);
      expect(targets).not.toContain('light.elsewhere_tree');
      expect(targets).not.toContain('light.elsewhere_hedge');
    });

    it("does not treat another area's theme scene as this garden's", () => {
      const result = run(sceneActivated('scene.elsewhere_spooky'));
      expect(result.decision).not.toBe('schedule_effects');
    });

    it('only clears effects from lights in roles some theme actually uses', () => {
      const accentOnly = makeThemeEffectsAutomation({ location: LOCATION, themes: { spooky: { accent: 'fireplace' } } });
      const result = testAutomation(accentOnly, { event: sceneActivated(NORMAL_SCENE), state: enabled, ha: makeHa() });
      expect(result.actions).toEqual([{ type: 'timer.cancel', timerKey: SETTLE_TIMER }, effectCall(ACCENT, 'stop_hue_effect')]);
    });
  });
});
