import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import type { DeclaredDecision } from '@ajclarkson/homerun';
import { clamp } from './clamp.js';

// Same range as the input_number helper and the Pulse room settings stepper.
export const LUX_THRESHOLD_DARK_RANGE = { min: 0, max: 500 } as const;

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
  /** Entity id of the first active suppressor (sorted, so it is stable), or null when none is on. */
  externalSuppressSource: string | null;
  isDay: boolean;
  guestModeActive: boolean;
  isCurrentlyOff: boolean;
  scenes: SceneSet;
  recentAutoOffMs: number;
  occupancySensorState: string | null;
}

// Every reason the reducer can return. Reasons are static (no values embedded in the name), so
// an outcome that depends on the trigger is two reasons: `automation_disabled` is `declined`
// when a person walking in found the automation off, `automation_disabled_idle` is noise.
export const LIGHTING_REASONS = {
  lux_low: { outcome: 'acted', facts: ['lux', 'lux_threshold', 'scene'] },
  recent_auto_off: { outcome: 'acted', facts: ['scene'] },
  occupancy_off: { outcome: 'acted' },
  occupancy_settle_off: { outcome: 'acted' },
  button_off: { outcome: 'acted' },
  button_cycle: { outcome: 'acted', facts: ['scene'] },
  house_sleep_mode: { outcome: 'acted' },
  lux_high: { outcome: 'declined', facts: ['lux', 'lux_threshold'] },
  sleep_mode: { outcome: 'declined' },
  sleep_mode_idle: { outcome: 'ignored' },
  external_suppress_active: { outcome: 'declined', facts: ['source'] },
  guest_room_sleep_bypass: { outcome: 'declined' },
  automation_disabled: { outcome: 'declined' },
  automation_disabled_idle: { outcome: 'ignored' },
  occupancy_off_already_off: { outcome: 'ignored' },
  house_sleep_mode_already_off: { outcome: 'ignored' },
  recent_auto_off_expired: { outcome: 'ignored' },
  already_on: { outcome: 'ignored' },
  startup_check_ok: { outcome: 'ignored' },
  no_matching_rule: { outcome: 'ignored' },
  occupancy_sensor_not_valid: { outcome: 'ignored' },
  occupancy_sensor_restored_on: { outcome: 'ignored' },
  occupancy_settle_pending: { outcome: 'ignored' },
  occupancy_settle_sensor_not_valid: { outcome: 'ignored' },
  occupancy_settle_sensor_on: { outcome: 'ignored' },
  occupancy_settle_already_off: { outcome: 'ignored' },
} as const;

type LightingDecision = DeclaredDecision<typeof LIGHTING_REASONS>;

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

  return defineAutomation<LightingContext, typeof LIGHTING_REASONS>({
    reasons: LIGHTING_REASONS,
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
      const externalSuppressSource = [...suppressEntities].sort()
        .find(e => state(e as keyof HAEntities)?.state === 'on') ?? null;
      const externalSuppressActive = externalSuppressSource !== null;

      const luxRaw = parseFloat(state(`sensor.${location}_sensor_motion_illuminance` as keyof HAEntities)?.state ?? '');
      const lux = Number.isFinite(luxRaw) ? luxRaw : null;
      const luxThreshRaw = parseFloat(state(`input_number.${location}_automation_lux_threshold_dark` as keyof HAEntities)?.state ?? '');
      if (!Number.isFinite(luxThreshRaw)) return abort(`lux_threshold_unavailable:${location}`);
      const luxThreshold = clamp(luxThreshRaw, LUX_THRESHOLD_DARK_RANGE.min, LUX_THRESHOLD_DARK_RANGE.max);
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
        houseMode, blockedBySleep, recentAutoOff, externalSuppressActive, externalSuppressSource, isDay,
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

// Facts are integers or null, so a consumer never formats 40.00000001 or NaN.
const roundedOrNull = (n: number | null) => (n === null ? null : Math.round(n));

function reduceRules(ctx: LightingContext, occupancySettleMs: number): LightingDecision {
  const {
    location, trigger, automationEnabled, lux, luxThreshold, occupied, activeScene,
    blockedBySleep, recentAutoOff, externalSuppressSource, isDay, guestModeActive,
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
    // Declined only when someone walked in and got no light because of it.
    const walkedIn = trigger.type === 'occupancy' && trigger.to === 'occupied';
    return {
      decision: 'no_action',
      reason: walkedIn ? 'automation_disabled' : 'automation_disabled_idle',
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
    // Lights already off: the scene is still re-asserted (a lamp may have been switched on by hand),
    // but nothing was switched off, so it is not news.
    return {
      decision: 'turn_off',
      reason: isCurrentlyOff ? 'house_sleep_mode_already_off' : 'house_sleep_mode',
      actions: [...planScene(scenes.off), ...planRecentAutoOffCancel(location)],
    };
  }

  // Rule 3: sleep mode blocks occupancy-triggered on
  if (blockedBySleep && occupied) {
    // Declined only when someone walking in was kept in the dark; any other trigger (a restart,
    // a timer) merely finds the house asleep.
    const walkedIn = trigger.type === 'occupancy' && trigger.to === 'occupied';
    return { decision: 'no_action', reason: walkedIn ? 'sleep_mode' : 'sleep_mode_idle', actions: [] };
  }

  // Rule 4: external suppress blocks motion-triggered on
  if (externalSuppressSource !== null && trigger.type === 'occupancy' && trigger.to === 'occupied') {
    return { decision: 'no_action', reason: 'external_suppress_active', facts: { source: externalSuppressSource }, actions: [] };
  }

  // Rule 5: occupancy cleared
  if (trigger.type === 'occupancy' && trigger.to === 'unoccupied') {
    // Leaving a room whose lights were already off (a bright room, a daytime walk-through) must not
    // open the recent-off window: re-entering within it would light the room regardless of lux.
    if (isCurrentlyOff) {
      return { decision: 'no_action', reason: 'occupancy_off_already_off', actions: planScene(scenes.off) };
    }
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
    const nextScene = nextCycleScene(scenes, activeScene);
    return {
      decision: 'activate_scene',
      reason: 'button_cycle',
      facts: { scene: toSceneKey(nextScene) },
      actions: [...planScene(nextScene), ...planRecentAutoOffCancel(location)],
    };
  }

  // Rule 7: occupancy set
  if (trigger.type === 'occupancy' && trigger.to === 'occupied') {
    const luxFacts = { lux: roundedOrNull(lux), lux_threshold: roundedOrNull(luxThreshold) };
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
        facts: { scene: toSceneKey(autoScene) },
        actions: [...planScene(autoScene), ...planRecentAutoOffCancel(location)],
      };
    }
    if (lux !== null && lux > luxThreshold) {
      return {
        decision: 'no_action',
        reason: 'lux_high',
        facts: luxFacts,
        actions: planRecentAutoOffCancel(location),
      };
    }
    return {
      decision: 'activate_scene',
      reason: 'lux_low',
      facts: { ...luxFacts, scene: toSceneKey(autoScene) },
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
