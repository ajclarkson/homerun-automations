import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import type { Action, DeclaredDecision, HAContext, TriggerEvent } from '@ajclarkson/homerun';
import { isSceneActivation } from './scene-activation.js';
import { clamp } from './clamp.js';
import { MIN_KELVIN, MAX_KELVIN, MIN_BRIGHTNESS, MAX_BRIGHTNESS, readLook, parseLook, serializeLook, lookAction, setLook, type Look } from './porch-look.js';

export const PORCH_LABEL = 'outdoor_light_porch';

// Bounds are the specification: whatever the config or the helper says, nothing outside them is emitted.
export const MIN_HOLD_S = 15;
export const MAX_HOLD_S = 600;
export const MAX_FADE_S = 30;
// Same settle the theme effects use: a scene's own commands are still landing right after it activates.
export const SCENE_SETTLE_MS = 1500;
// The bulb reports kelvin via mireds and brightness in 0-255, so a commanded look reads back slightly off.
const KELVIN_TOLERANCE = 100;
const BRIGHTNESS_TOLERANCE = 3;
// Slack after the fade-down for the bulb to land and HA to report it.
export const FADE_MARGIN_MS = 1000;

export interface PorchLightConfig {
  location: string;
  warm: { colorTempKelvin: number; brightness: number };
  fadeUpS: number;
  fadeDownS: number;
  /** Theme name -> false to ignore motion while that theme's scene is active. Omitted themes react. */
  motionThemes?: Record<string, boolean>;
}

// Warming and restoring the porch are `acted`. Timer bookkeeping and the many motion events that
// correctly do nothing (daylight, already warm) are `ignored`; `declined` is for the cases a person
// would ask about: a theme that opted out of motion, or a look that could not be saved or restored.
export const PORCH_LIGHT_REASONS = {
  motion_detected: { outcome: 'acted' },
  scene_changed_during_hold: { outcome: 'acted' },
  motion_during_fade_back: { outcome: 'acted' },
  hold_expired: { outcome: 'acted' },
  hold_expired_look_missing_garden_off: { outcome: 'acted' },
  automation_disabled_restore: { outcome: 'acted' },
  look_unreadable: { outcome: 'declined', facts: ['problem'] },
  restore_look_missing: { outcome: 'declined' },
  theme_opted_out: { outcome: 'declined' },
  automation_disabled_idle: { outcome: 'ignored' },
  startup: { outcome: 'ignored' },
  scene_reloaded_not_activated: { outcome: 'ignored' },
  scene_changed_during_motion: { outcome: 'ignored' },
  scene_changed_hold_dropped: { outcome: 'ignored' },
  motion_cleared_not_warm: { outcome: 'ignored' },
  motion_cleared: { outcome: 'ignored' },
  motion_still_on: { outcome: 'ignored' },
  motion_cleared_before_settle: { outcome: 'ignored' },
  daylight: { outcome: 'ignored' },
  already_warm: { outcome: 'ignored' },
} as const;

type PorchDecision = DeclaredDecision<typeof PORCH_LIGHT_REASONS>;

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
  /** The saved look is a complete, valid look. */
  restoreLookValid: boolean;
  /** Why the porch's current look can't be saved, or null when it can. */
  lookProblem: string | null;
  /** The porch's current look, ready to save. Null when lookProblem is set. */
  currentLook: Look | null;
  /** The saved look, null when restoreLookValid is false. */
  savedLook: Look | null;
  nowMs: number;
  /** The porch was sent back to its saved look moments ago and is still fading there. */
  restoreFading: boolean;
  holdMs: number;
}

// Entities created at runtime or after the last codegen are not in HAEntities, so reads go through one cast.
interface Reading { state: string; attributes?: Record<string, unknown> }

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const usable = (s: string | undefined) => s !== undefined && s !== 'unavailable' && s !== 'unknown';

function requireFinite(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`porch light config '${name}' must be a finite number, got ${value}`);
  return value;
}

function validatedConfig(config: PorchLightConfig) {
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
  const { location, fadeUpS, fadeDownS, kelvin, brightness } = { ...config, ...validatedConfig(config) };
  const motionSensor = `binary_sensor.${location}_sensor_motion_occupancy`;
  const holdKey = `${location}:porch_motion_hold`;
  const settleKey = `${location}:porch_scene_settle`;
  const lookHelper = `input_text.${location}_automation_porch_restore`;
  const optedOutThemes = Object.entries(config.motionThemes ?? {}).filter(([, reacts]) => !reacts).map(([theme]) => theme);
  const sceneRegex = new RegExp(`^scene\\.${escapeRegExp(location)}_`);

  const cancel = (timerKey: string): Action => ({ type: 'timer.cancel', timerKey });
  const warmUp = (porch: string): Action =>
    HomeAssistant.light.turn_on({ entity_id: porch }, { color_temp_kelvin: kelvin, brightness, transition: fadeUpS });
  // Fade the porch back and mark the fade in the helper, so motion during it can't save a half-faded look.
  const fadeBack = (porch: string, look: Look, nowMs: number): Action[] => [
    setLook(lookHelper, serializeLook(look, nowMs + fadeDownS * 1000 + FADE_MARGIN_MS)),
    lookAction(porch, look, fadeDownS),
  ];
  const saveAndWarm = (porch: string, look: Look): Action[] =>
    [setLook(lookHelper, serializeLook(look)), warmUp(porch), cancel(holdKey)];

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

  function porchIsWarm(porchState: Reading): boolean {
    return porchState.state === 'on'
      && Math.abs(readNumber(porchState, 'brightness') - brightness) <= BRIGHTNESS_TOLERANCE
      && Math.abs(readNumber(porchState, 'color_temp_kelvin') - kelvin) <= KELVIN_TOLERANCE;
  }

  return defineAutomation<PorchLightContext, typeof PORCH_LIGHT_REASONS>({
    reasons: PORCH_LIGHT_REASONS,
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
      const helperState = read(lookHelper)?.state;
      if (helperState === undefined || helperState === 'unavailable') return abort(`porch_restore_helper_unavailable:${lookHelper}`);
      const saved = parseLook(helperState);
      const current = readLook(porchState.state, porchState.attributes);
      const nowMs = Date.now();
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
        restoreLookValid: saved !== null,
        lookProblem: typeof current === 'string' ? current : null,
        currentLook: typeof current === 'string' ? null : current,
        savedLook: saved?.look ?? null,
        restoreFading: saved?.fadeEndsMs != null && nowMs >= saved.fadeEndsMs - fadeDownS * 1000 - FADE_MARGIN_MS && nowMs < saved.fadeEndsMs,
        nowMs,
        holdMs: clamp(holdSeconds, MIN_HOLD_S, MAX_HOLD_S) * 1000,
      };
    },

    reduce: (ctx): PorchDecision => {
      const { trigger, porch, automationEnabled, dark, motionOn, porchWarm, themeAllowsMotion, gardenOff,
        realSceneActivation, restoreLookValid, lookProblem, currentLook, savedLook, restoreFading, nowMs, holdMs } = ctx;
      const clearTimers = [cancel(holdKey), cancel(settleKey)];
      const motionWarm = (reason: 'motion_detected' | 'scene_changed_during_hold', decision: string): PorchDecision => {
        // Nothing is warmed if the current look can't be saved: an unrestorable warm porch is worse than a dark one.
        if (lookProblem !== null || currentLook === null) {
          return { decision: 'no_action', reason: 'look_unreadable', facts: { problem: lookProblem ?? 'uninitialised' }, actions: [] };
        }
        return { decision, reason, actions: saveAndWarm(porch, currentLook) };
      };

      // Rule 1: a switched-off automation must not leave the porch warm.
      if (!automationEnabled) {
        if (porchWarm && savedLook !== null) return { decision: 'restore', reason: 'automation_disabled_restore', actions: [...clearTimers, ...fadeBack(porch, savedLook, nowMs)] };
        return { decision: 'no_action', reason: 'automation_disabled_idle', actions: clearTimers };
      }
      if (trigger === 'startup') return { decision: 'no_action', reason: 'startup', actions: [] };

      if (trigger === 'scene_activated') {
        if (!realSceneActivation) return { decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] };
        // The scene has just replaced the warm look, so the pending fade-back would undo it: drop it. A fade
        // marker in the helper is dropped too, so motion right after the scene saves the scene's look.
        const dropMarker = restoreFading && savedLook !== null ? [setLook(lookHelper, serializeLook(savedLook))] : [];
        if (motionOn) {
          return { decision: 'schedule_rewarm', reason: 'scene_changed_during_motion',
            actions: [...dropMarker, cancel(holdKey), { type: 'timer.start', timerKey: settleKey, delayMs: SCENE_SETTLE_MS }] };
        }
        return { decision: 'no_action', reason: 'scene_changed_hold_dropped', actions: [...dropMarker, ...clearTimers] };
      }

      if (trigger === 'motion_off') {
        if (!porchWarm) return { decision: 'no_action', reason: 'motion_cleared_not_warm', actions: [] };
        return { decision: 'hold', reason: 'motion_cleared', actions: [{ type: 'timer.start', timerKey: holdKey, delayMs: holdMs }] };
      }

      if (trigger === 'hold_expired') {
        if (motionOn) return { decision: 'no_action', reason: 'motion_still_on', actions: [] };
        if (savedLook !== null) return { decision: 'restore', reason: 'hold_expired', actions: fadeBack(porch, savedLook, nowMs) };
        // No usable saved look (helper cleared or garbled); the next garden scene sets the porch.
        if (gardenOff) {
          return { decision: 'restore', reason: 'hold_expired_look_missing_garden_off',
            actions: [HomeAssistant.light.turn_off({ entity_id: porch }, { transition: fadeDownS })] };
        }
        return { decision: 'no_action', reason: 'restore_look_missing', actions: [] };
      }

      // motion_on, or scene_settled (re-run of the motion-on rules against the porch the scene just set).
      if (!motionOn) return { decision: 'no_action', reason: 'motion_cleared_before_settle', actions: [] };
      if (!dark) return { decision: 'no_action', reason: 'daylight', actions: [] };
      if (!themeAllowsMotion) return { decision: 'no_action', reason: 'theme_opted_out', actions: [] };
      // Mid fade-back the porch reads as neither warm nor resting; saving it would trap that look.
      if (restoreFading && savedLook !== null && trigger === 'motion_on') {
        return { decision: 'warm', reason: 'motion_during_fade_back', actions: [setLook(lookHelper, serializeLook(savedLook)), warmUp(porch), cancel(holdKey)] };
      }
      if (porchWarm) return { decision: 'no_action', reason: 'already_warm', actions: [cancel(holdKey)] };
      return trigger === 'scene_settled'
        ? motionWarm('scene_changed_during_hold', 'rewarm')
        : motionWarm('motion_detected', 'warm');
    },
  });
}
