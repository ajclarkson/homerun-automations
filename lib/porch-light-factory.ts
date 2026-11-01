import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import type { Action, HAContext, TriggerEvent } from '@ajclarkson/homerun';
import { isSceneActivation } from './scene-activation.js';

export const PORCH_LABEL = 'outdoor_light_porch';

// Bounds are the specification: whatever the config or the helper says, nothing outside them is emitted.
export const MIN_HOLD_S = 15;
export const MAX_HOLD_S = 600;
export const MIN_KELVIN = 2000; // the bulb's supported range
export const MAX_KELVIN = 9009;
export const MIN_BRIGHTNESS = 1;
export const MAX_BRIGHTNESS = 255;
export const MAX_FADE_S = 30;
// Same settle the theme effects use: a scene's own commands are still landing right after it activates.
export const SCENE_SETTLE_MS = 1500;
// The bulb reports kelvin via mireds and brightness in 0-255, so a commanded look reads back slightly off.
const KELVIN_TOLERANCE = 100;
const BRIGHTNESS_TOLERANCE = 3;
// Slack after the fade-down for the bulb to land and HA to report it.
const FADE_MARGIN_MS = 1000;

export interface PorchLightConfig {
  location: string;
  warm: { colorTempKelvin: number; brightness: number };
  fadeUpS: number;
  fadeDownS: number;
  /**
   * Runtime scene id (without the `scene.` domain) that holds the porch's look while it is warm. It must not
   * start with `<location>_`: the theme effects and active-scene sensor listen to `scene.<location>_*`.
   */
  restoreSceneId: string;
  /** Theme name -> false to ignore motion while that theme's scene is active. Omitted themes react. */
  motionThemes?: Record<string, boolean>;
}

type PorchTrigger =
  | 'motion_on' | 'motion_off' | 'hold_expired' | 'scene_activated' | 'scene_settled' | 'startup';

interface PorchLightContext {
  trigger: PorchTrigger;
  porch: string;
  automationEnabled: boolean;
  dark: boolean;
  motionOn: boolean;
  /** The porch is showing this automation's warm look right now. */
  porchWarm: boolean;
  themeAllowsMotion: boolean;
  /** The active scene is the area's off scene. */
  gardenOff: boolean;
  /** False when a scene's state changed because HA reloaded scenes, not because it was activated. */
  realSceneActivation: boolean;
  snapshotExists: boolean;
  /** The snapshot was activated moments ago and the porch is still fading back to it. */
  restoreFading: boolean;
  holdMs: number;
}

// Entities created at runtime or after the last codegen are not in HAEntities, so reads go through one cast.
interface Reading { state: string; attributes?: Record<string, unknown> }

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);
const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const usable = (s: string | undefined) => s !== undefined && s !== 'unavailable' && s !== 'unknown';

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`porch light config '${name}' must be a finite number, got ${value}`);
  return value;
}

function validatedConfig(config: PorchLightConfig) {
  const { location, restoreSceneId } = config;
  if (restoreSceneId.startsWith(`${location}_`)) {
    throw new Error(`porch restoreSceneId '${restoreSceneId}' must not start with '${location}_'`);
  }
  return {
    kelvin: clamp(requireFinite(config.warm.colorTempKelvin, 'warm.colorTempKelvin'), MIN_KELVIN, MAX_KELVIN),
    brightness: clamp(Math.round(requireFinite(config.warm.brightness, 'warm.brightness')), MIN_BRIGHTNESS, MAX_BRIGHTNESS),
    fadeUpS: clamp(requireFinite(config.fadeUpS, 'fadeUpS'), 0, MAX_FADE_S),
    fadeDownS: clamp(requireFinite(config.fadeDownS, 'fadeDownS'), 0, MAX_FADE_S),
  };
}

function findPorch(ha: HAContext, location: string): string | ReturnType<typeof abort> {
  const inArea = ha.entitiesByArea(location);
  const porches = ha.entitiesByLabel(PORCH_LABEL).filter(e => e.startsWith('light.') && inArea.includes(e));
  if (porches.length === 0) return abort(`porch_light_not_found:${location}`);
  if (porches.length > 1) return abort(`porch_light_ambiguous:${location}:${porches.length}`);
  return porches[0];
}

function readNumber(entity: Reading | undefined, key: string): number {
  const raw = entity?.attributes?.[key];
  return typeof raw === 'number' ? raw : NaN;
}

export function makePorchLightAutomation(config: PorchLightConfig) {
  const { location, restoreSceneId, fadeUpS, fadeDownS, kelvin, brightness } = { ...config, ...validatedConfig(config) };
  const motionSensor = `binary_sensor.${location}_sensor_motion_occupancy`;
  const holdKey = `${location}:porch_motion_hold`;
  const settleKey = `${location}:porch_scene_settle`;
  const restoreScene = `scene.${restoreSceneId}`;
  const optedOutThemes = Object.entries(config.motionThemes ?? {}).filter(([, reacts]) => !reacts).map(([theme]) => theme);
  const sceneRegex = new RegExp(`^scene\\.${escapeRegExp(location)}_`);

  const cancel = (timerKey: string): Action => ({ type: 'timer.cancel', timerKey });
  const snapshot = (porch: string): Action => ({
    type: 'ha.call_service', domain: 'scene', service: 'create',
    data: { scene_id: restoreSceneId, snapshot_entities: [porch] },
  });
  const warmUp = (porch: string): Action =>
    HomeAssistant.light.turn_on({ entity_id: porch }, { color_temp_kelvin: kelvin, brightness, transition: fadeUpS });
  const restore: Action = HomeAssistant.scene.turn_on({ entity_id: restoreScene }, { transition: fadeDownS });

  function triggerOf(event: TriggerEvent): PorchTrigger | ReturnType<typeof abort> {
    if (event.type === 'on_start') return 'startup';
    if (event.type === 'timer_expired') return event.timerKey === holdKey ? 'hold_expired' : 'scene_settled';
    if (event.type !== 'state_changed') return abort(`unexpected_trigger:${event.type}`);
    if (event.entity_id !== motionSensor) return 'scene_activated';
    const s = event.new_state.state;
    if (s === 'on') return 'motion_on';
    if (s === 'off') return 'motion_off';
    return abort(`motion_event_state_unexpected:${s}`);
  }

  // Only a theme scene whose theme opted out suppresses motion; the off scene and no scene both react.
  function themeAllowsMotion(ha: HAContext, activeScene: string | null): boolean {
    if (activeScene === null) return true;
    const inArea = ha.entitiesByArea(location);
    return !optedOutThemes.some(theme => ha.entitiesByLabel(`scene_theme_${theme}`).some(e => e === activeScene && inArea.includes(e)));
  }

  // A scene's state is the ISO time of its last activation; scene.create leaves it unknown until then.
  // Unparseable or future times are not a fade, so the normal path (fresh snapshot) runs.
  function isFading(snapshotState: string | undefined, nowMs: number): boolean {
    const activatedMs = Date.parse(snapshotState ?? '');
    if (!Number.isFinite(activatedMs)) return false;
    const elapsedMs = nowMs - activatedMs;
    return elapsedMs >= 0 && elapsedMs < fadeDownS * 1000 + FADE_MARGIN_MS;
  }

  function porchIsWarm(porchState: Reading): boolean {
    return porchState.state === 'on'
      && Math.abs(readNumber(porchState, 'brightness') - brightness) <= BRIGHTNESS_TOLERANCE
      && Math.abs(readNumber(porchState, 'color_temp_kelvin') - kelvin) <= KELVIN_TOLERANCE;
  }

  return defineAutomation<PorchLightContext>({
    id: `${location}:porch_light`,
    location,
    subsystem: 'lighting',

    triggers: [
      { type: 'state_changed', entity: motionSensor as keyof HAEntities },
      { type: 'timer_expired', timerKey: holdKey },
      { type: 'timer_expired', timerKey: settleKey },
      { type: 'state_changed', entity: sceneRegex },
      { type: 'on_start' },
    ],

    context: (state, ha, event) => {
      const read = (id: string) => state(id as keyof HAEntities) as Reading | undefined;
      const trigger = triggerOf(event);
      if (typeof trigger !== 'string') return trigger;
      const porch = findPorch(ha, location);
      if (typeof porch !== 'string') return porch;

      const porchState = read(porch);
      if (!porchState || !usable(porchState.state)) return abort(`porch_unavailable:${porch}`);
      const motion = read(motionSensor)?.state;
      if (motion !== 'on' && motion !== 'off') return abort(`motion_sensor_unavailable:${motion}`);
      const sun = read('sun.sun')?.state;
      if (sun !== 'above_horizon' && sun !== 'below_horizon') return abort(`sun_unavailable:${sun}`);
      const holdSeconds = Number(read(`input_number.${location}_automation_porch_hold`)?.state);
      if (!Number.isFinite(holdSeconds)) return abort(`porch_hold_unavailable:${location}`);

      const active = read(`sensor.${location}_active_scene`)?.state;
      const activeScene = usable(active) ? `scene.${active}` : null;
      const offScenes = ha.entitiesByLabel('scene_control_off').filter(e => ha.entitiesByArea(location).includes(e));
      const snapshotState = read(restoreScene)?.state;
      const sceneEvent = event.type === 'state_changed' && event.entity_id !== motionSensor ? event : null;

      return {
        trigger,
        porch,
        automationEnabled: read(`input_boolean.${location}_automation_lights_enabled`)?.state === 'on',
        dark: sun === 'below_horizon',
        motionOn: motion === 'on',
        porchWarm: porchIsWarm(porchState),
        themeAllowsMotion: themeAllowsMotion(ha, activeScene),
        gardenOff: activeScene !== null && offScenes.includes(activeScene),
        realSceneActivation: sceneEvent === null || isSceneActivation(sceneEvent.old_state?.state, sceneEvent.new_state.state),
        snapshotExists: snapshotState !== undefined && snapshotState !== 'unavailable',
        restoreFading: isFading(snapshotState, Date.now()),
        holdMs: clamp(holdSeconds, MIN_HOLD_S, MAX_HOLD_S) * 1000,
      };
    },

    reduce: (ctx) => {
      const { trigger, porch, automationEnabled, dark, motionOn, porchWarm, themeAllowsMotion, gardenOff,
        realSceneActivation, snapshotExists, restoreFading, holdMs } = ctx;
      const clearTimers = [cancel(holdKey), cancel(settleKey)];
      const motionWarm = (reason: string, decision: string) => ({
        decision, reason, actions: [snapshot(porch), warmUp(porch), cancel(holdKey)],
      });

      // Rule 1: a switched-off automation must not leave the porch warm.
      if (!automationEnabled) {
        if (porchWarm && snapshotExists) return { decision: 'restore', reason: 'automation_disabled', actions: [...clearTimers, restore] };
        return { decision: 'no_action', reason: 'automation_disabled', actions: clearTimers };
      }
      if (trigger === 'startup') return { decision: 'no_action', reason: 'startup', actions: [] };

      if (trigger === 'scene_activated') {
        if (!realSceneActivation) return { decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] };
        // The scene has just replaced the warm look, so the pending fade-back would undo it: drop it.
        if (motionOn) {
          return { decision: 'schedule_rewarm', reason: 'scene_changed_during_motion',
            actions: [cancel(holdKey), { type: 'timer.start', timerKey: settleKey, delayMs: SCENE_SETTLE_MS }] };
        }
        return { decision: 'no_action', reason: 'scene_changed_hold_dropped', actions: clearTimers };
      }

      if (trigger === 'motion_off') {
        if (!porchWarm) return { decision: 'no_action', reason: 'motion_cleared_not_warm', actions: [] };
        return { decision: 'hold', reason: 'motion_cleared', actions: [{ type: 'timer.start', timerKey: holdKey, delayMs: holdMs }] };
      }

      if (trigger === 'hold_expired') {
        if (motionOn) return { decision: 'no_action', reason: 'motion_still_on', actions: [] };
        if (snapshotExists) return { decision: 'restore', reason: 'hold_expired', actions: [restore] };
        // HA restarted during the hold and lost the runtime scene; the next garden scene sets the porch.
        if (gardenOff) {
          return { decision: 'restore', reason: 'hold_expired_snapshot_missing_garden_off',
            actions: [HomeAssistant.light.turn_off({ entity_id: porch }, { transition: fadeDownS })] };
        }
        return { decision: 'no_action', reason: 'restore_snapshot_missing', actions: [] };
      }

      // motion_on, or scene_settled (re-run of the motion-on rules against the porch the scene just set).
      if (!motionOn) return { decision: 'no_action', reason: 'motion_cleared_before_settle', actions: [] };
      if (!dark) return { decision: 'no_action', reason: 'daylight', actions: [] };
      if (!themeAllowsMotion) return { decision: 'no_action', reason: 'theme_opted_out', actions: [] };
      // Mid fade-back the porch reads as neither warm nor resting; snapshotting it would trap that look.
      if (restoreFading && snapshotExists && trigger === 'motion_on') {
        return { decision: 'warm', reason: 'motion_during_fade_back', actions: [warmUp(porch), cancel(holdKey)] };
      }
      if (porchWarm) return { decision: 'no_action', reason: 'already_warm', actions: [cancel(holdKey)] };
      return trigger === 'scene_settled'
        ? motionWarm('scene_changed_during_hold', 'rewarm')
        : motionWarm('motion_detected', 'warm');
    },
  });
}
