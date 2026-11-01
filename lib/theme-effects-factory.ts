import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';
import type { Action } from '@ajclarkson/homerun';
import { isSceneActivation } from './scene-activation.js';

// Lights take part in themes by role, assigned with HA labels and filtered to the location's area.
export type LightRole = 'feature' | 'accent';
const ROLE_LABELS: Record<LightRole, string> = {
  feature: 'outdoor_light_feature',
  accent: 'outdoor_light_accent',
};

export interface ThemeEffectsConfig {
  location: string;
  /** On-bulb Hue effect per role, keyed by theme name (the theme's scene carries scene_theme_<theme>). */
  themes: Record<string, Partial<Record<LightRole, string>>>;
}

// Scenes can't reliably carry effects, and an effect sent while the scene's own colour commands are
// still landing gets overwritten — so effects are applied once the scene has had time to settle.
export const EFFECTS_SETTLE_MS = 1500;
const STOP_EFFECT = 'stop_hue_effect';

type ThemeEffectsTrigger = 'scene_activated' | 'scene_settled' | 'system';

interface EffectCommand {
  entity_id: string;
  effect: string;
}

interface ThemeEffectsContext {
  trigger: ThemeEffectsTrigger;
  automationEnabled: boolean;
  /** False when a scene's state changed because HA reloaded scenes, not because it was activated. */
  realActivation: boolean;
  /** The scene that was just activated (scene_activated) or is currently active (otherwise). */
  scene: string | null;
  /** Theme that scene belongs to, if that theme has effects configured. */
  effectsTheme: string | null;
  sceneIsOff: boolean;
  /** Effects to start for effectsTheme — one per light in each configured role. */
  start: EffectCommand[];
  /** Every light in a role any theme uses — cleared when a scene without effects takes over. */
  stopLights: string[];
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeThemeEffectsAutomation(config: ThemeEffectsConfig) {
  const { location, themes } = config;
  const settleTimerKey = `${location}:theme_effects_settle`;
  const usedRoles = (Object.keys(ROLE_LABELS) as LightRole[])
    .filter(role => Object.values(themes).some(effects => effects[role]));

  return defineAutomation<ThemeEffectsContext>({
    id: `${location}:theme_effects`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'state_changed', entity: new RegExp(`^scene\\.${escapeRegExp(location)}_`) },
      { type: 'timer_expired', timerKey: settleTimerKey },
      { type: 'on_start' },
    ],

    context: (state, ha, event) => {
      const areaEntities = ha.entitiesByArea(location);
      const inArea = (label: string) => ha.entitiesByLabel(label).filter(e => areaEntities.includes(e));
      const lightsFor = (role: LightRole) => inArea(ROLE_LABELS[role]).filter(e => e.startsWith('light.'));

      let trigger: ThemeEffectsTrigger;
      let scene: string | null;
      let realActivation = true;
      if (event.type === 'state_changed') {
        trigger = 'scene_activated';
        scene = event.entity_id;
        realActivation = isSceneActivation(event.old_state?.state, event.new_state.state);
      } else {
        trigger = event.type === 'timer_expired' ? 'scene_settled' : 'system';
        const active = state(`sensor.${location}_active_scene` as keyof HAEntities)?.state;
        scene = active && active !== 'unknown' && active !== 'unavailable' ? `scene.${active}` : null;
      }

      // A scene belongs to a theme via its scene_theme_<theme> label in this area.
      const effectsTheme = scene
        ? Object.keys(themes).find(theme => inArea(`scene_theme_${theme}`).includes(scene)) ?? null
        : null;
      const start = effectsTheme
        ? usedRoles.flatMap(role => {
            const effect = themes[effectsTheme][role];
            return effect ? lightsFor(role).map(entity_id => ({ entity_id, effect })) : [];
          })
        : [];

      return {
        trigger,
        automationEnabled: state(`input_boolean.${location}_automation_lights_enabled` as keyof HAEntities)?.state === 'on',
        realActivation,
        scene,
        effectsTheme,
        sceneIsOff: scene !== null && inArea('scene_control_off').includes(scene),
        start,
        stopLights: [...new Set(usedRoles.flatMap(lightsFor))],
      };
    },

    reduce: (ctx) => {
      const { trigger, automationEnabled, realActivation, effectsTheme, sceneIsOff, start, stopLights } = ctx;
      const effectOn = ({ entity_id, effect }: EffectCommand): Action =>
        HomeAssistant.light.turn_on({ entity_id }, { effect });
      const cancelSettle: Action = { type: 'timer.cancel', timerKey: settleTimerKey };

      if (!automationEnabled) {
        return { decision: 'no_action', reason: 'automation_disabled', actions: [] };
      }

      if (trigger === 'scene_activated') {
        if (!realActivation) {
          return { decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] };
        }
        if (effectsTheme) {
          return {
            decision: 'schedule_effects',
            reason: 'theme_scene_activated',
            actions: [{ type: 'timer.start', timerKey: settleTimerKey, delayMs: EFFECTS_SETTLE_MS }],
          };
        }
        if (sceneIsOff) {
          // Effects end with the lights — only a pending start needs stopping.
          return { decision: 'cancel_effects', reason: 'off_scene_activated', actions: [cancelSettle] };
        }
        if (stopLights.length === 0) {
          return { decision: 'no_action', reason: 'no_effect_lights', actions: [cancelSettle] };
        }
        // A new colour doesn't reliably cancel a running Hue effect, so clear any that may be running.
        return {
          decision: 'stop_effects',
          reason: 'scene_without_effects_activated',
          actions: [cancelSettle, ...stopLights.map(entity_id => effectOn({ entity_id, effect: STOP_EFFECT }))],
        };
      }

      // scene_settled / system: start effects for whatever scene is active now.
      if (!effectsTheme) {
        return { decision: 'no_action', reason: 'no_effects_theme_active', actions: [] };
      }
      if (start.length === 0) {
        return { decision: 'no_action', reason: 'no_lights_in_theme_roles', actions: [] };
      }
      return {
        decision: 'start_effects',
        reason: trigger === 'system' ? 'startup_with_theme_active' : 'theme_scene_settled',
        actions: start.map(effectOn),
      };
    },
  });
}
