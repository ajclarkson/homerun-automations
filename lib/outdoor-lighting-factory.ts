import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

export interface OutdoorLightingConfig {
  location: string;
  /**
   * Local time ('HH:MM') the evening window closes and the lights turn off. Defaults to 22:00.
   * May be at or after midnight (e.g. '00:00', '01:30'): the window runs from sunset until this time.
   */
  offTime?: string;
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

type OutdoorLightingTrigger = 'sunset' | 'sunrise' | 'schedule_off' | 'sleep_mode' | 'theme_changed' | 'system';

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
}

export function makeOutdoorLightingAutomation(config: OutdoorLightingConfig) {
  const { location, offTime = DEFAULT_OFF_TIME } = config;
  const off = parseOffTime(offTime);
  const offMinutesSinceNoon = minutesSinceNoon(off.hour, off.minute);
  const themeEntity = `input_select.${location}_light_theme`;

  return defineAutomation<OutdoorLightingContext>({
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

      return { trigger, automationEnabled, inOnWindow, houseAsleep, lightsDue, theme, themeSceneMissing, onScene, offScene };
    },

    reduce: (ctx) => {
      const { trigger, automationEnabled, inOnWindow, houseAsleep, lightsDue, onScene, offScene } = ctx;
      const sceneOn = (entity_id: string) => HomeAssistant.scene.turn_on({ entity_id }, { transition: 0.5 });

      if (!automationEnabled) {
        return { decision: 'no_action', reason: 'automation_disabled', actions: [] };
      }

      if (trigger === 'sleep_mode') {
        return { decision: 'turn_off', reason: 'house_sleep_mode', actions: [sceneOn(offScene)] };
      }

      if (trigger === 'sunset' && inOnWindow) {
        if (houseAsleep) {
          return { decision: 'no_action', reason: 'sunset_while_house_asleep', actions: [] };
        }
        return { decision: 'turn_on', reason: 'sunset', actions: [sceneOn(onScene)] };
      }

      if (trigger === 'schedule_off' || trigger === 'sunrise') {
        return { decision: 'turn_off', reason: trigger, actions: [sceneOn(offScene)] };
      }

      if (trigger === 'theme_changed') {
        // Only restyle lights that should currently be on — never wake the garden after the off time or in sleep.
        if (!lightsDue) {
          return { decision: 'no_action', reason: 'theme_changed_while_off', actions: [] };
        }
        return { decision: 'turn_on', reason: 'theme_changed', actions: [sceneOn(onScene)] };
      }

      if (trigger === 'system') {
        return {
          decision: lightsDue ? 'turn_on' : 'turn_off',
          reason: 'startup_sync',
          actions: [sceneOn(lightsDue ? onScene : offScene)],
        };
      }

      return { decision: 'no_action', reason: 'no_matching_rule', actions: [] };
    },
  });
}
