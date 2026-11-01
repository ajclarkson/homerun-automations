import { describe, it, expect } from 'vitest';
import { testAutomation } from '@ajclarkson/homerun/testing';
import type { HAContext } from '@ajclarkson/homerun';
import automation from './theme-effects.js';

const BIRCH = 'light.front_garden_light_birch';
const MAPLE = 'light.front_garden_light_maple';

const ha: Partial<HAContext> = {
  entitiesByArea: (a) => (a === 'front_garden'
    ? [BIRCH, MAPLE, 'scene.front_garden_halloween', 'scene.front_garden_bonfire', 'scene.front_garden_autumn']
    : []),
  entitiesByLabel: (label) => ({
    outdoor_light_feature: [BIRCH],
    outdoor_light_accent: [MAPLE],
    scene_theme_halloween: ['scene.front_garden_halloween'],
    scene_theme_bonfire: ['scene.front_garden_bonfire'],
    scene_theme_autumn: ['scene.front_garden_autumn'],
  } as Record<string, string[]>)[label] ?? [],
};

function settledOn(scene: string) {
  return testAutomation(automation, {
    event: { type: 'timer_expired', timerKey: 'front_garden:theme_effects_settle', correlation_id: 'test-cid' },
    state: {
      'input_boolean.front_garden_automation_lights_enabled': { state: 'on' },
      'sensor.front_garden_active_scene': { state: scene },
    },
    ha,
  });
}

const effect = (entity_id: string, name: string) =>
  expect.objectContaining({ target: { entity_id }, data: expect.objectContaining({ effect: name }) });

describe('front garden theme effects', () => {
  it('gives only the maple a fireplace flicker for Halloween — the birch has its own animation', () => {
    expect(settledOn('front_garden_halloween').actions).toEqual([effect(MAPLE, 'fireplace')]);
  });

  it('sets both trees flickering like a bonfire on Bonfire Night', () => {
    expect(settledOn('front_garden_bonfire').actions).toEqual([effect(BIRCH, 'fireplace'), effect(MAPLE, 'fireplace')]);
  });

  it('runs no effects for Autumn', () => {
    expect(settledOn('front_garden_autumn')).toMatchObject({ decision: 'no_action', reason: 'no_effects_theme_active' });
  });
});
