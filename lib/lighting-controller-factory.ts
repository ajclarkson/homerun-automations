import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

export interface LightingRoomConfig {
  location: string;
  disableInSleepMode?: boolean;
  recentAutoOffMins?: number;
  // How long a room must stay `off` after a sensor outage/restart before the lights are
  // switched off. Gives a returning sensor time to report real motion first.
  occupancySettleMins?: number;
}

type LightingTrigger =
  | { type: 'occupancy'; to: 'occupied' | 'unoccupied' }
  | { type: 'occupancy_invalid' }
  | { type: 'occupancy_restored' }
  | { type: 'occupancy_settle_start' }
  | { type: 'occupancy_settle_fired' }
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
  occupancySensorState: string | null;
}

const MIN_TIMER_DELAY_MS =      1_000; // 1 second
const MAX_TIMER_DELAY_MS = 3_600_000; // 1 hour

const clampTimerMs = (mins: number) =>
  Math.min(Math.max(mins * 60 * 1000, MIN_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);

const planSettleStart = (location: string, delayMs: number) =>
  [{ type: 'timer.start' as const, timerKey: `${location}:lighting_occupancy_settle`, delayMs }];

const planSettleCancel = (location: string) =>
  [{ type: 'timer.cancel' as const, timerKey: `${location}:lighting_occupancy_settle` }];

// HA active_scene sensor stores scene name without 'scene.' prefix.
const toSceneKey = (entityId: string) =>
  entityId.startsWith('scene.') ? entityId.slice(6) : entityId;

const isValidOccupancyState = (s: unknown): s is 'on' | 'off' => s === 'on' || s === 'off';

// Only a change between two valid states is a real occupancy transition. An HA restart or
// Z2M outage walks the sensor through null/unavailable/unknown; treating any of those as
// "unoccupied" switched every light off. A first valid `off` after an outage is not trusted
// immediately; it starts a settle timer and is re-checked when that fires.
function classifyOccupancyChange(oldState: unknown, newState: unknown): LightingTrigger {
  if (!isValidOccupancyState(newState)) return { type: 'occupancy_invalid' };
  if (!isValidOccupancyState(oldState)) {
    // Sensor is back after an outage: `on` only cancels a pending settle; `off` starts one,
    // because the room may have emptied during the outage and no on->off will ever fire.
    return newState === 'on' ? { type: 'occupancy_restored' } : { type: 'occupancy_settle_start' };
  }
  return { type: 'occupancy', to: newState === 'on' ? 'occupied' : 'unoccupied' };
}

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
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'ON', retain: true, impliesEntity: `binary_sensor.${location}_lighting_recent_auto_off` },
    { type: 'timer.start' as const, timerKey: `${location}:lighting_recent_auto_off`, delayMs },
  ];
}

function planRecentAutoOffOff(location: string) {
  return [
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'OFF', retain: true, impliesEntity: `binary_sensor.${location}_lighting_recent_auto_off` },
  ];
}

function planRecentAutoOffCancel(location: string) {
  return [
    { type: 'mqtt.publish' as const, topic: `${location}/lighting/recent_auto_off`, payload: 'OFF', retain: true, impliesEntity: `binary_sensor.${location}_lighting_recent_auto_off` },
    { type: 'timer.cancel' as const, timerKey: `${location}:lighting_recent_auto_off` },
  ];
}

export function makeLightingAutomation(config: LightingRoomConfig) {
  const { location, disableInSleepMode = true, recentAutoOffMins = 5, occupancySettleMins = 5 } = config;
  const recentAutoOffMs = clampTimerMs(recentAutoOffMins);
  const occupancySettleMs = clampTimerMs(occupancySettleMins);

  const buttonEntity = new RegExp(`sensor\\.${location}_button_.*_action`);

  return defineAutomation<LightingContext>({
    id: `${location}:lighting`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'state_changed', entity: `binary_sensor.${location}_occupied` as keyof HAEntities },
      { type: 'button', entity: buttonEntity, gesture: 'single_press' },
      { type: 'button', entity: buttonEntity, gesture: 'hold' },
      { type: 'state_changed', entity: 'sensor.house_active_mode' },
      { type: 'timer_expired', timerKey: `${location}:lighting_recent_auto_off` },
      { type: 'timer_expired', timerKey: `${location}:lighting_occupancy_settle` },
      { type: 'on_start' },
    ],

    context: (state, ha, event) => {
      // Trigger classification
      let trigger: LightingTrigger;
      if (event.type === 'button') {
        trigger = { type: 'button', gesture: event.gesture === 'hold' ? 'hold' : 'single_press' };
      } else if (event.type === 'timer_expired') {
        trigger = event.timerKey === `${location}:lighting_occupancy_settle`
          ? { type: 'occupancy_settle_fired' }
          : { type: 'timer' };
      } else if (event.type === 'state_changed') {
        if (event.entity_id === `binary_sensor.${location}_occupied`) {
          trigger = classifyOccupancyChange(event.old_state?.state, event.new_state?.state);
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
      const externalSuppressActive = suppressEntities.some(e => state(e as keyof HAEntities)?.state === 'on');

      const luxRaw = parseFloat(state(`sensor.${location}_sensor_motion_illuminance` as keyof HAEntities)?.state ?? '');
      const lux = Number.isFinite(luxRaw) ? luxRaw : null;
      const luxThreshRaw = parseFloat(state(`input_number.${location}_automation_lux_threshold_dark` as keyof HAEntities)?.state ?? '');
      if (!Number.isFinite(luxThreshRaw)) return abort(`lux_threshold_unavailable:${location}`);
      const luxThreshold = luxThreshRaw;
      const automationEnabled = state(`input_boolean.${location}_automation_lights_enabled` as keyof HAEntities)?.state === 'on';
      const houseMode = state('sensor.house_active_mode')?.state ?? 'unknown';
      const houseModifier = state('input_select.house_active_mode_modifier')?.state ?? 'none';
      const presenceOverride = state(`input_boolean.${location}_automation_presence_override` as keyof HAEntities)?.state === 'on';
      const guestModeActive = houseModifier === 'guest' && presenceOverride;
      const occupancySensorState = state(`binary_sensor.${location}_occupied` as keyof HAEntities)?.state ?? null;
      const occupied = state(`binary_sensor.${location}_occupied` as keyof HAEntities)?.state === 'on';
      const activeScene = state(`sensor.${location}_active_scene` as keyof HAEntities)?.state ?? null;
      const recentAutoOff = state(`binary_sensor.${location}_lighting_recent_auto_off` as keyof HAEntities)?.state === 'on';
      const isDay = state('sun.sun')?.state === 'above_horizon';
      const blockedBySleep = houseMode === 'sleep' && disableInSleepMode;

      const scenes: SceneSet = { off: offScene, daylight: daylightScene, night: nightScene, ordered };
      const isCurrentlyOff = activeScene === toSceneKey(offScene);

      return {
        location, trigger, automationEnabled, lux, luxThreshold, occupied, activeScene,
        houseMode, blockedBySleep, recentAutoOff, externalSuppressActive, isDay,
        guestModeActive, isCurrentlyOff, scenes, recentAutoOffMs, occupancySensorState,
      };
    },

    reduce: (ctx) => {
      const result = reduceRules(ctx, occupancySettleMs);
      // A real occupancy change supersedes any pending post-outage settle check.
      if (ctx.trigger.type === 'occupancy') {
        return { ...result, actions: [...result.actions, ...planSettleCancel(ctx.location)] };
      }
      return result;
    },
  });
}

function reduceRules(ctx: LightingContext, occupancySettleMs: number) {
  const {
    location, trigger, automationEnabled, lux, luxThreshold, occupied, activeScene,
    blockedBySleep, recentAutoOff, externalSuppressActive, isDay, guestModeActive,
    isCurrentlyOff, scenes, recentAutoOffMs, occupancySensorState,
  } = ctx;

  // Rule 0: timer expired — clear the recent_auto_off flag
  if (trigger.type === 'timer') {
    return {
      decision: 'clear_recent_auto_off',
      reason: 'recent_auto_off_expired',
      actions: planRecentAutoOffOff(location),
    };
  }

  // Rule 0b: occupancy sensor outage/restart noise — never act, never touch recent_auto_off
  if (trigger.type === 'occupancy_invalid') {
    return { decision: 'no_action', reason: 'occupancy_sensor_not_valid', actions: [] };
  }

  // Rule 0c: sensor back as `on` after an outage — only cancel the settle check
  if (trigger.type === 'occupancy_restored') {
    return { decision: 'no_action', reason: 'occupancy_sensor_restored_on', actions: planSettleCancel(location) };
  }

  // Rule 1: automation disabled
  if (!automationEnabled) {
    return {
      decision: 'no_action',
      reason: 'automation_disabled',
      actions: planRecentAutoOffCancel(location),
    };
  }

  // Rule 1b: first valid `off` after an outage — defer the decision
  if (trigger.type === 'occupancy_settle_start') {
    return {
      decision: 'no_action',
      reason: 'occupancy_settle_pending',
      actions: planSettleStart(location, occupancySettleMs),
    };
  }

  // Rule 1c: settle timer fired — re-read the sensor; never re-arm, so a sensor that stays
  // invalid is left alone until its next valid transition.
  if (trigger.type === 'occupancy_settle_fired') {
    if (!isValidOccupancyState(occupancySensorState)) {
      return { decision: 'no_action', reason: 'occupancy_settle_sensor_not_valid', actions: [] };
    }
    if (occupancySensorState === 'on') {
      return { decision: 'no_action', reason: 'occupancy_settle_sensor_on', actions: [] };
    }
    if (isCurrentlyOff) {
      return { decision: 'no_action', reason: 'occupancy_settle_already_off', actions: [] };
    }
    return {
      decision: 'turn_off',
      reason: 'occupancy_settle_off',
      actions: [...planScene(scenes.off), ...planRecentAutoOffOn(location, recentAutoOffMs)],
    };
  }

  // Rule 2: house entering sleep mode
  if (trigger.type === 'house_mode' && trigger.to === 'sleep') {
    if (guestModeActive) {
      return { decision: 'no_action', reason: 'guest_room_sleep_bypass', actions: [] };
    }
    return {
      decision: 'turn_off',
      reason: 'house_sleep_mode',
      actions: [...planScene(scenes.off), ...planRecentAutoOffCancel(location)],
    };
  }

  // Rule 3: sleep mode blocks occupancy-triggered on
  if (blockedBySleep && occupied) {
    return { decision: 'no_action', reason: 'sleep_mode', actions: [] };
  }

  // Rule 4: external suppress blocks motion-triggered on
  if (externalSuppressActive && trigger.type === 'occupancy' && trigger.to === 'occupied') {
    return { decision: 'no_action', reason: 'external_suppress_active', actions: [] };
  }

  // Rule 5: occupancy cleared
  if (trigger.type === 'occupancy' && trigger.to === 'unoccupied') {
    return {
      decision: 'turn_off',
      reason: 'occupancy_off',
      actions: [...planScene(scenes.off), ...planRecentAutoOffOn(location, recentAutoOffMs)],
    };
  }

  // Rule 6: button press
  if (trigger.type === 'button') {
    if (trigger.gesture === 'hold') {
      return {
        decision: 'turn_off',
        reason: 'button_off',
        actions: [...planScene(scenes.off), ...planRecentAutoOffOn(location, recentAutoOffMs)],
      };
    }
    return {
      decision: 'activate_scene',
      reason: 'button_cycle',
      actions: [...planScene(nextCycleScene(scenes, activeScene)), ...planRecentAutoOffCancel(location)],
    };
  }

  // Rule 7: occupancy set
  if (trigger.type === 'occupancy' && trigger.to === 'occupied') {
    if (!isCurrentlyOff) {
      return {
        decision: 'no_action',
        reason: 'already_on',
        actions: planRecentAutoOffCancel(location),
      };
    }
    const autoScene = selectAutoScene(scenes, isDay);
    if (recentAutoOff) {
      return {
        decision: 'activate_scene',
        reason: 'recent_auto_off',
        actions: [...planScene(autoScene), ...planRecentAutoOffCancel(location)],
      };
    }
    if (lux !== null && lux > luxThreshold) {
      return {
        decision: 'no_action',
        reason: 'lux_high',
        actions: planRecentAutoOffCancel(location),
      };
    }
    return {
      decision: 'activate_scene',
      reason: 'lux_low',
      actions: [...planScene(autoScene), ...planRecentAutoOffCancel(location)],
    };
  }

  // Rule 8: on_start — no scene resync (would clobber manual overrides); this tick's
  // only job is exercising the validation above (scene labels, lux threshold) at boot.
  if (trigger.type === 'system') {
    return { decision: 'no_action', reason: 'startup_check_ok', actions: [] };
  }

  return { decision: 'no_action', reason: 'no_matching_rule', actions: [] };
}
