import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import type { Action, DeclaredDecision } from '@ajclarkson/homerun';
import { isSceneActivation } from './scene-activation.js';

export interface OutdoorLightingConfig {
  location: string;
  /**
   * Local time ('HH:MM') the evening window closes and the lights turn off. Defaults to 22:00.
   * May be at or after midnight (e.g. '00:00', '01:30'): the window runs from sunset until this time.
   */
  offTime?: string;
  /**
   * Minutes a scene switched on by hand outside the evening window stays on before the garden goes
   * off again (a positive integer). Omit for no limit: a daytime tap then stays on until the off time.
   */
  previewMinutes?: number;
}

const DEFAULT_OFF_TIME = '22:00';
const MINUTES_PER_DAY = 24 * 60;
const NOON = 12 * 60;

function parseOffTime(offTime: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(offTime);
  if (!match) throw new Error(`invalid outdoor lighting offTime '${offTime}' — expected 'HH:MM'`);
  return { hour: Number(match[1]), minute: Number(match[2]) };
}

// Minutes elapsed since the most recent noon, so an evening window that crosses midnight
// is still one contiguous range (e.g. 22:00 → 600, 00:00 → 720, 01:30 → 810).
const minutesSinceNoon = (hour: number, minute: number) =>
  (hour * 60 + minute - NOON + MINUTES_PER_DAY) % MINUTES_PER_DAY;

// Theme selected via input_select.<location>_light_theme. 'normal' (or no helper at all) uses the
// scene_order_1 scene; any other theme uses the area's scene labelled scene_theme_<theme>.
const NORMAL_THEME = 'normal';

type OutdoorLightingTrigger =
  | 'sunset' | 'sunrise' | 'schedule_off' | 'sleep_mode' | 'theme_changed' | 'system'
  | 'scene_activated' | 'preview_expired';

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function validatePreviewMinutes(previewMinutes: number | undefined): void {
  if (previewMinutes === undefined) return;
  if (!Number.isInteger(previewMinutes) || previewMinutes <= 0) {
    throw new Error(`invalid outdoor lighting previewMinutes '${previewMinutes}' — expected a positive integer`);
  }
}

// `automation_disabled` is declined only at sunset, when the evening lights were due; on any
// other trigger it is noise (`automation_disabled_idle`). Two reasons keep the declaration static.
// `startup_sync` is ignored although it sends a scene: it restores what is already due, and a
// restart is not news.
export const OUTDOOR_LIGHTING_REASONS = {
  sunset: { outcome: 'acted' },
  schedule_off: { outcome: 'acted' },
  sunrise: { outcome: 'acted' },
  house_sleep_mode: { outcome: 'acted' },
  preview_ended: { outcome: 'acted' },
  theme_changed: { outcome: 'acted', facts: ['theme'] },
  theme_scene_missing: { outcome: 'acted', facts: ['theme'] },
  on_outside_evening_window: { outcome: 'acted', facts: ['minutes'] },
  sunset_while_house_asleep: { outcome: 'declined' },
  automation_disabled: { outcome: 'declined' },
  automation_disabled_idle: { outcome: 'ignored' },
  startup_sync: { outcome: 'ignored' },
  theme_changed_while_off: { outcome: 'ignored' },
  preview_ended_in_window: { outcome: 'ignored' },
  scene_activated_in_window: { outcome: 'ignored' },
  scene_reloaded_not_activated: { outcome: 'ignored' },
  no_matching_rule: { outcome: 'ignored' },
} as const;

type OutdoorDecision = DeclaredDecision<typeof OUTDOOR_LIGHTING_REASONS>;

interface OutdoorLightingContext {
  trigger: OutdoorLightingTrigger;
  automationEnabled: boolean;
  inOnWindow: boolean;
  houseAsleep: boolean;
  lightsDue: boolean;
  theme: string;
  themeSceneMissing: boolean;
  onScene: string;
  offScene: string;
  /** scene_activated only: the scene that changed is this location's off scene. */
  activatedIsOff: boolean;
  /** scene_activated only: the scene is one of this location's area scenes. */
  activatedInArea: boolean;
  /** scene_activated only: a real activation, not a scenes reload restoring old timestamps. */
  realActivation: boolean;
}

export function makeOutdoorLightingAutomation(config: OutdoorLightingConfig) {
  const { location, offTime = DEFAULT_OFF_TIME, previewMinutes } = config;
  const off = parseOffTime(offTime);
  validatePreviewMinutes(previewMinutes);
  const previewTimerKey = `${location}:lighting:preview_off`;
  const offMinutesSinceNoon = minutesSinceNoon(off.hour, off.minute);
  const themeEntity = `input_select.${location}_light_theme`;

  return defineAutomation<OutdoorLightingContext, typeof OUTDOOR_LIGHTING_REASONS>({
    reasons: OUTDOOR_LIGHTING_REASONS,
    id: `${location}:lighting`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'state_changed', entity: 'sun.sun', to: 'below_horizon' },
      { type: 'state_changed', entity: 'sun.sun', to: 'above_horizon' },
      { type: 'schedule', cron: `${off.minute} ${off.hour} * * *` },
      { type: 'state_changed', entity: 'sensor.house_active_mode', to: 'sleep' },
      { type: 'state_changed', entity: themeEntity as keyof HAEntities },
      { type: 'on_start' },
      // Only gardens with a preview limit watch scenes, so the others keep their exact triggers.
      ...(previewMinutes !== undefined
        ? [
            { type: 'state_changed' as const, entity: new RegExp(`^scene\\.${escapeRegExp(location)}_`) },
            { type: 'timer_expired' as const, timerKey: previewTimerKey },
          ]
        : []),
    ],

    context: (state, ha, event) => {
      let trigger: OutdoorLightingTrigger;
      if (event.type === 'state_changed' && event.entity_id === 'sun.sun') {
        trigger = event.new_state.state === 'below_horizon' ? 'sunset' : 'sunrise';
      } else if (event.type === 'schedule') {
        trigger = 'schedule_off';
      } else if (event.type === 'state_changed' && event.entity_id === 'sensor.house_active_mode' && event.new_state.state === 'sleep') {
        trigger = 'sleep_mode';
      } else if (event.type === 'state_changed' && event.entity_id === themeEntity) {
        trigger = 'theme_changed';
      } else if (event.type === 'state_changed') {
        trigger = 'scene_activated';
      } else if (event.type === 'timer_expired') {
        trigger = 'preview_expired';
      } else {
        trigger = 'system';
      }

      // Scene discovery via HA labels, filtered to this location's area
      const areaEntities = ha.entitiesByArea(location);
      const findScene = (label: string) =>
        ha.entitiesByLabel(label).find(e => areaEntities.includes(e)) ?? null;

      const normalScene = findScene('scene_order_1');
      if (!normalScene) return abort(`no_on_scene_configured_for_${location}`);
      const offScene = findScene('scene_control_off');
      if (!offScene) return abort(`no_off_scene_configured_for_${location}`);

      // A location without a theme helper (or with it unavailable) runs its normal scene.
      const themeState = state(themeEntity as keyof HAEntities)?.state;
      const theme = themeState && themeState !== 'unavailable' && themeState !== 'unknown' ? themeState : NORMAL_THEME;
      const themeScene = theme === NORMAL_THEME ? normalScene : findScene(`scene_theme_${theme}`);
      const themeSceneMissing = themeScene === null;
      const onScene = themeScene ?? normalScene;

      const automationEnabled = state(`input_boolean.${location}_automation_lights_enabled` as keyof HAEntities)?.state === 'on';
      const sunBelowHorizon = state('sun.sun')?.state === 'below_horizon';
      const now = new Date();
      const inOnWindow = sunBelowHorizon && minutesSinceNoon(now.getHours(), now.getMinutes()) < offMinutesSinceNoon;
      const houseAsleep = state('sensor.house_active_mode')?.state === 'sleep';
      const lightsDue = inOnWindow && !houseAsleep;

      const activated = event.type === 'state_changed' && trigger === 'scene_activated' ? event : null;
      return {
        trigger, automationEnabled, inOnWindow, houseAsleep, lightsDue, theme, themeSceneMissing, onScene, offScene,
        activatedIsOff: activated?.entity_id === offScene,
        activatedInArea: activated !== null && areaEntities.includes(activated.entity_id),
        realActivation: activated !== null && isSceneActivation(activated.old_state?.state, activated.new_state.state),
      };
    },

    reduce: (ctx): OutdoorDecision => {
      const { trigger, automationEnabled, inOnWindow, houseAsleep, lightsDue, theme, themeSceneMissing, onScene, offScene } = ctx;
      const sceneOn = (entity_id: string) => HomeAssistant.scene.turn_on({ entity_id }, { transition: 0.5 });
      // A missing theme scene is a config gap, so it must not hide behind the ordinary reason.
      const turnOn = (reason: 'sunset' | 'theme_changed'): OutdoorDecision =>
        themeSceneMissing
          ? { decision: 'turn_on', reason: 'theme_scene_missing', facts: { theme }, actions: [sceneOn(onScene)] }
          : reason === 'theme_changed'
            ? { decision: 'turn_on', reason, facts: { theme }, actions: [sceneOn(onScene)] }
            : { decision: 'turn_on', reason, actions: [sceneOn(onScene)] };

      if (!automationEnabled) {
        // Declined only when the sunset that should have lit the garden found it switched off.
        return { decision: 'no_action', reason: trigger === 'sunset' ? 'automation_disabled' : 'automation_disabled_idle', actions: [] };
      }

      if (trigger === 'scene_activated') return reduceSceneActivated(ctx);

      if (trigger === 'preview_expired') {
        // Sunset may have arrived mid-preview: the normal evening has taken over, so leave it on.
        if (lightsDue) return { decision: 'no_action', reason: 'preview_ended_in_window', actions: [] };
        return { decision: 'turn_off', reason: 'preview_ended', actions: [sceneOn(offScene)] };
      }

      if (trigger === 'sleep_mode') {
        return { decision: 'turn_off', reason: 'house_sleep_mode', actions: [sceneOn(offScene)] };
      }

      if (trigger === 'sunset' && inOnWindow) {
        if (houseAsleep) {
          return { decision: 'no_action', reason: 'sunset_while_house_asleep', actions: [] };
        }
        return turnOn('sunset');
      }

      if (trigger === 'schedule_off' || trigger === 'sunrise') {
        return { decision: 'turn_off', reason: trigger, actions: [sceneOn(offScene)] };
      }

      if (trigger === 'theme_changed') {
        // Only restyle lights that should currently be on — never wake the garden after the off time or in sleep.
        if (!lightsDue) {
          return { decision: 'no_action', reason: 'theme_changed_while_off', actions: [] };
        }
        return turnOn('theme_changed');
      }

      if (trigger === 'system') {
        // Retained, so HA knows the window (and any preview limit) without asking homerun.
        const publishWindow: Action = {
          type: 'mqtt.publish',
          topic: `${location}/lighting/window`,
          payload: JSON.stringify({ off: offTime, preview_min: previewMinutes ?? null }),
          retain: true,
        };
        const actions = [sceneOn(lightsDue ? onScene : offScene), publishWindow];
        if (lightsDue && themeSceneMissing) return { decision: 'turn_on', reason: 'theme_scene_missing', facts: { theme }, actions };
        return { decision: lightsDue ? 'turn_on' : 'turn_off', reason: 'startup_sync', actions };
      }

      return { decision: 'no_action', reason: 'no_matching_rule', actions: [] };
    },
  });

  function reduceSceneActivated(ctx: OutdoorLightingContext): OutdoorDecision {
    const { lightsDue, activatedIsOff, activatedInArea, realActivation } = ctx;
    // Reloads restore old timestamps; they say nothing about anyone switching the garden on.
    if (!realActivation) return { decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] };
    if (activatedIsOff || !activatedInArea) return { decision: 'no_action', reason: 'no_matching_rule', actions: [] };
    if (lightsDue) return { decision: 'no_action', reason: 'scene_activated_in_window', actions: [] };
    if (previewMinutes === undefined) throw new Error(`${location}: scene trigger fired without previewMinutes configured`);
    // timer.start on a running key restarts it, so a second tap extends the preview; expiry re-checks the state.
    return {
      decision: 'start_preview',
      reason: 'on_outside_evening_window',
      facts: { minutes: previewMinutes },
      actions: [{ type: 'timer.start', timerKey: previewTimerKey, delayMs: previewMinutes * 60_000 } as Action],
    };
  }
}
