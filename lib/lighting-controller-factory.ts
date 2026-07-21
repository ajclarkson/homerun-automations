import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

export interface LightingRoomConfig {
  location: string;
  disableInSleepMode?: boolean;
  recentAutoOffMins?: number;
}

type LightingTrigger =
  | { type: 'occupancy'; to: 'occupied' | 'unoccupied' }
  | { type: 'button'; gesture: 'single_press' | 'hold' }
  | { type: 'house_mode'; to: string }
  | { type: 'timer' }
  | { type: 'system' };

interface SceneSet {
  off: string;
  daylight: string | null;
  night: string | null;
  ordered: string[];
}

interface LightingContext {
  location: string;
  trigger: LightingTrigger;
  automationEnabled: boolean;
  lux: number | null;
  luxThreshold: number;
  occupied: boolean;
  activeScene: string | null;
  houseMode: string;
  blockedBySleep: boolean;
  recentAutoOff: boolean;
  externalSuppressActive: boolean;
  isDay: boolean;
  guestModeActive: boolean;
  isCurrentlyOff: boolean;
  scenes: SceneSet;
  recentAutoOffMs: number;
  inputs: Record<string, unknown>;
}

// HA active_scene sensor stores scene name without 'scene.' prefix.
const toSceneKey = (entityId: string) =>
  entityId.startsWith('scene.') ? entityId.slice(6) : entityId;

function selectAutoScene(scenes: SceneSet, isDay: boolean): string {
  if (isDay && scenes.daylight) return scenes.daylight;
  if (!isDay && scenes.night) return scenes.night;
  return scenes.ordered[0] ?? scenes.off;
}

function nextCycleScene(scenes: SceneSet, activeScene: string | null): string {
  if (scenes.ordered.length === 0) return scenes.off;
  const idx = scenes.ordered.findIndex(s => toSceneKey(s) === activeScene);
  if (idx === -1 || idx === scenes.ordered.length - 1) return scenes.ordered[0];
  return scenes.ordered[idx + 1];
}

function planScene(scene: string) {
  return [HomeAssistant.scene.turn_on({ entity_id: scene }, { transition: 0.5 })];
}

function planRecentAutoOffOn(location: string, delayMs: number) {
  return [
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'ON', retain: true },
    { type: 'timer.start' as const, timerKey: `${location}:lighting_recent_auto_off`, delayMs },
  ];
}

function planRecentAutoOffOff(location: string) {
  return [
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'OFF', retain: true },
  ];
}

function planRecentAutoOffCancel(location: string) {
  return [
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'OFF', retain: true },
    { type: 'timer.cancel' as const, timerKey: `${location}:lighting_recent_auto_off` },
  ];
}

export function makeLightingAutomation(config: LightingRoomConfig) {
  const { location, disableInSleepMode = true, recentAutoOffMins = 5 } = config;
  const recentAutoOffMs = recentAutoOffMins * 60 * 1000;

  const buttonEntity = new RegExp(`sensor\\.${location}_button_.*_action`);

  return defineAutomation<LightingContext>({
    id: `${location}:lighting`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'state_changed', entity: `binary_sensor.${location}_occupied` },
      { type: 'button', entity: buttonEntity, gesture: 'single_press' },
      { type: 'button', entity: buttonEntity, gesture: 'hold' },
      { type: 'state_changed', entity: 'sensor.house_active_mode' },
      { type: 'timer_expired', timerKey: `${location}:lighting_recent_auto_off` },
      { type: 'on_start' },
    ],

    context: (state, ha, event) => {
      // Trigger classification
      let trigger: LightingTrigger;
      if (event.type === 'button') {
        trigger = { type: 'button', gesture: event.gesture === 'hold' ? 'hold' : 'single_press' };
      } else if (event.type === 'timer_expired') {
        trigger = { type: 'timer' };
      } else if (event.type === 'state_changed') {
        if (event.entity_id === `binary_sensor.${location}_occupied`) {
          trigger = { type: 'occupancy', to: event.new_state.state === 'on' ? 'occupied' : 'unoccupied' };
        } else if (event.entity_id === 'sensor.house_active_mode') {
          trigger = { type: 'house_mode', to: event.new_state.state };
        } else {
          trigger = { type: 'system' };
        }
      } else {
        trigger = { type: 'system' };
      }

      // Scene discovery via HA labels, filtered to this room's area
      const areaEntities = ha.entitiesByArea(location);
      const findScene = (label: string) =>
        ha.entitiesByLabel(label).find(e => areaEntities.includes(e)) ?? null;

      const offScene = findScene('scene_control_off');
      if (!offScene) return abort(`no_off_scene_configured_for_${location}`);

      const daylightScene = findScene('scene_control_daylight');
      const nightScene = findScene('scene_control_night');
      const ordered: string[] = [];
      for (let i = 1; ; i++) {
        const s = findScene(`scene_order_${i}`);
        if (!s) break;
        ordered.push(s);
      }

      // Entities suppressing motion-triggered on (e.g. bed occupancy in hallway_upstairs)
      const suppressEntities = ha.entitiesByLabel('lighting_suppress_when_on')
        .filter(e => areaEntities.includes(e));
      const externalSuppressActive = suppressEntities.some(e => state(e)?.state === 'on');

      const luxRaw = parseFloat(state(`sensor.${location}_sensor_motion_illuminance`)?.state ?? '');
      const lux = Number.isFinite(luxRaw) ? luxRaw : null;
      const luxThreshRaw = parseFloat(state(`input_number.${location}_automation_lux_threshold_dark`)?.state ?? '');
      if (!Number.isFinite(luxThreshRaw)) return abort(`lux_threshold_unavailable:${location}`);
      const luxThreshold = luxThreshRaw;
      const automationEnabled = state(`input_boolean.${location}_automation_lights_enabled`)?.state === 'on';
      const houseMode = state('sensor.house_active_mode')?.state ?? 'unknown';
      const houseModifier = state('input_select.house_active_mode_modifier')?.state ?? 'none';
      const presenceOverride = state(`input_boolean.${location}_automation_presence_override`)?.state === 'on';
      const guestModeActive = houseModifier === 'guest' && presenceOverride;
      const occupied = state(`binary_sensor.${location}_occupied`)?.state === 'on';
      const activeScene = state(`sensor.${location}_active_scene`)?.state ?? null;
      const recentAutoOff = state(`binary_sensor.${location}_lighting_recent_auto_off`)?.state === 'on';
      const isDay = state('sun.sun')?.state === 'above_horizon';
      const blockedBySleep = houseMode === 'sleep' && disableInSleepMode;

      const scenes: SceneSet = { off: offScene, daylight: daylightScene, night: nightScene, ordered };
      const isCurrentlyOff = activeScene === toSceneKey(offScene);

      const inputs = {
        trigger,
        automationEnabled,
        lux,
        luxThreshold,
        occupied,
        activeScene,
        isCurrentlyOff,
        houseMode,
        blockedBySleep,
        recentAutoOff,
        externalSuppressActive,
        isDay,
        guestModeActive,
        scenes: { off: offScene, daylight: daylightScene, night: nightScene, ordered },
      };

      return {
        location, trigger, automationEnabled, lux, luxThreshold, occupied, activeScene,
        houseMode, blockedBySleep, recentAutoOff, externalSuppressActive, isDay,
        guestModeActive, isCurrentlyOff, scenes, recentAutoOffMs, inputs,
      };
    },

    reduce: (ctx) => {
      const {
        location, trigger, automationEnabled, lux, luxThreshold, occupied, activeScene,
        blockedBySleep, recentAutoOff, externalSuppressActive, isDay, guestModeActive,
        isCurrentlyOff, scenes, recentAutoOffMs,
      } = ctx;

      // Rule 0: timer expired — clear the recent_auto_off flag
      if (trigger.type === 'timer') {
        return {
          decision: 'clear_recent_auto_off',
          reason: 'recent_auto_off_expired',
          inputs: ctx.inputs,
          actions: planRecentAutoOffOff(location),
        };
      }

      // Rule 1: automation disabled
      if (!automationEnabled) {
        return {
          decision: 'no_action',
          reason: 'automation_disabled',
          inputs: ctx.inputs,
          actions: planRecentAutoOffCancel(location),
        };
      }

      // Rule 2: house entering sleep mode
      if (trigger.type === 'house_mode' && trigger.to === 'sleep') {
        if (guestModeActive) {
          return { decision: 'no_action', reason: 'guest_room_sleep_bypass', inputs: ctx.inputs, actions: [] };
        }
        return {
          decision: 'turn_off',
          reason: 'house_sleep_mode',
          inputs: ctx.inputs,
          actions: [...planScene(scenes.off), ...planRecentAutoOffCancel(location)],
        };
      }

      // Rule 3: sleep mode blocks occupancy-triggered on
      if (blockedBySleep && occupied) {
        return { decision: 'no_action', reason: 'sleep_mode', inputs: ctx.inputs, actions: [] };
      }

      // Rule 4: external suppress blocks motion-triggered on
      if (externalSuppressActive && trigger.type === 'occupancy' && trigger.to === 'occupied') {
        return { decision: 'no_action', reason: 'external_suppress_active', inputs: ctx.inputs, actions: [] };
      }

      // Rule 5: occupancy cleared
      if (trigger.type === 'occupancy' && trigger.to === 'unoccupied') {
        return {
          decision: 'turn_off',
          reason: 'occupancy_off',
          inputs: ctx.inputs,
          actions: [...planScene(scenes.off), ...planRecentAutoOffOn(location, recentAutoOffMs)],
        };
      }

      // Rule 6: button press
      if (trigger.type === 'button') {
        if (trigger.gesture === 'hold') {
          return {
            decision: 'turn_off',
            reason: 'button_off',
            inputs: ctx.inputs,
            actions: [...planScene(scenes.off), ...planRecentAutoOffOn(location, recentAutoOffMs)],
          };
        }
        return {
          decision: 'activate_scene',
          reason: 'button_cycle',
          inputs: ctx.inputs,
          actions: [...planScene(nextCycleScene(scenes, activeScene)), ...planRecentAutoOffCancel(location)],
        };
      }

      // Rule 7: occupancy set
      if (trigger.type === 'occupancy' && trigger.to === 'occupied') {
        if (!isCurrentlyOff) {
          return {
            decision: 'no_action',
            reason: 'already_on',
            inputs: ctx.inputs,
            actions: planRecentAutoOffCancel(location),
          };
        }
        const autoScene = selectAutoScene(scenes, isDay);
        if (recentAutoOff) {
          return {
            decision: 'activate_scene',
            reason: 'recent_auto_off',
            inputs: ctx.inputs,
            actions: [...planScene(autoScene), ...planRecentAutoOffCancel(location)],
          };
        }
        if (lux !== null && lux > luxThreshold) {
          return {
            decision: 'no_action',
            reason: 'lux_high',
            inputs: ctx.inputs,
            actions: planRecentAutoOffCancel(location),
          };
        }
        return {
          decision: 'activate_scene',
          reason: 'lux_low',
          inputs: ctx.inputs,
          actions: [...planScene(autoScene), ...planRecentAutoOffCancel(location)],
        };
      }

      return { decision: 'no_action', reason: 'no_matching_rule', inputs: ctx.inputs, actions: [] };
    },
  });
}
