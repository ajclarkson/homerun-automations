import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';
import type { Action } from '@ajclarkson/homerun';
import { isSceneActivation } from '../lib/scene-activation.js';

// Halloween animation for the front garden's feature light(s) — the birch. Runs only while the
// Halloween theme scene is active, layered on top of it:
//   - drift: a fade between purple and sickly green, holding each colour for a while
//   - lightning: every 5–10 minutes a pair of strikes 5s apart (each a short dim flicker then a
//     short bright flash), until 20:30
// The accent light (maple) is left alone — its fireplace flicker is an on-bulb effect from
// front-garden/theme-effects.ts, and a white flash next to the street light would be lost.

const LOCATION = 'front_garden';
const FEATURE_LABEL = 'outdoor_light_feature';
const HALLOWEEN_SCENE_LABEL = 'scene_theme_halloween';

interface Colour {
  name: string;
  rgb: [number, number, number];
  brightness: number;
}

// Index 0 matches the Halloween scene's birch colour, so the first drift starts from the base look.
export const DRIFT_COLOURS: Colour[] = [
  { name: 'purple', rgb: [120, 30, 255], brightness: 220 },
  { name: 'green', rgb: [90, 255, 20], brightness: 200 },
];
// Colours alternate on fixed clock periods, so the current colour is always derivable from the time —
// no stored state, and a restart or a lightning restore lands on the right colour.
export const DRIFT_PERIOD_MS = 60_000;
export const DRIFT_TRANSITION_S = 20;
const DRIFT_BOUNDARY_OFFSET_MS = 500;

// Gap between one pair of strikes ending and the next pair starting.
export const LIGHTNING_MIN_GAP_MS = 5 * 60_000;
export const LIGHTNING_MAX_GAP_MS = 10 * 60_000;
// Each bolt is two strikes, the second (echo) starting this long after the first began.
export const ECHO_AFTER_MS = 5_000;
// No new bolts from this local time; a bolt already started finishes, and drift carries on.
export const LIGHTNING_CUTOFF = { hour: 20, minute: 30 };
const STRIKE_COLOUR: [number, number, number] = [200, 215, 255];
const FLICKER_BRIGHTNESS = 110;
const FLASH_BRIGHTNESS = 255;
// Tuned by eye on the birch: two short, separate flashes rather than one sustained glow, snapping
// straight back to the drift colour. Timings are from the start of the flicker.
export const FLICKER_MS = 100;
export const FLICKER_TO_FLASH_MS = 350;
export const FLASH_MS = 120;

export const TIMERS = {
  drift: `${LOCATION}:halloween_drift`,
  strike: `${LOCATION}:halloween_lightning`,
  flickerEnd: `${LOCATION}:halloween_lightning_flicker_end`,
  flash: `${LOCATION}:halloween_lightning_flash`,
  restore: `${LOCATION}:halloween_lightning_restore`,
  echo: `${LOCATION}:halloween_lightning_echo`,
  echoFlickerEnd: `${LOCATION}:halloween_lightning_echo_flicker_end`,
  echoFlash: `${LOCATION}:halloween_lightning_echo_flash`,
  echoRestore: `${LOCATION}:halloween_lightning_echo_restore`,
} as const;

type StrikePhase = 'strike' | 'flicker_end' | 'flash' | 'restore';
type HalloweenTrigger = 'scene_activated' | 'drift' | StrikePhase | 'system';
type StrikeNo = 1 | 2;

// Timer keys for each phase of the first strike and its echo.
const STRIKE_TIMERS: Record<StrikeNo, Record<StrikePhase, string>> = {
  1: { strike: TIMERS.strike, flicker_end: TIMERS.flickerEnd, flash: TIMERS.flash, restore: TIMERS.restore },
  2: { strike: TIMERS.echo, flicker_end: TIMERS.echoFlickerEnd, flash: TIMERS.echoFlash, restore: TIMERS.echoRestore },
};
const TIMER_TRIGGERS: Record<string, { trigger: HalloweenTrigger; strikeNo: StrikeNo | null }> = {
  [TIMERS.drift]: { trigger: 'drift', strikeNo: null },
  ...Object.fromEntries(([1, 2] as const).flatMap(strikeNo =>
    (Object.entries(STRIKE_TIMERS[strikeNo]) as [StrikePhase, string][]).map(([trigger, key]) => [key, { trigger, strikeNo }]))),
};

interface HalloweenContext {
  trigger: HalloweenTrigger;
  /** Which strike of the bolt a lightning step belongs to: 1 = first, 2 = echo. */
  strikeNo: StrikeNo | null;
  automationEnabled: boolean;
  /** False when a scene's state changed because HA reloaded scenes, not because it was activated. */
  realActivation: boolean;
  halloweenActive: boolean;
  featureLights: string[];
  driftColour: Colour;
  msToNextDrift: number;
  lightningOpen: boolean;
  nextStrikeMs: number;
}

export default defineAutomation<HalloweenContext>({
  id: `${LOCATION}:halloween`,
  location: LOCATION,
  subsystem: 'lighting',

  triggers: [
    { type: 'state_changed', entity: new RegExp(`^scene\\.${LOCATION}_`) },
    ...Object.values(TIMERS).map(timerKey => ({ type: 'timer_expired' as const, timerKey })),
    { type: 'on_start' },
  ],

  context: (state, ha, event) => {
    const areaEntities = ha.entitiesByArea(LOCATION);
    const inArea = (label: string) => ha.entitiesByLabel(label).filter(e => areaEntities.includes(e));

    let trigger: HalloweenTrigger;
    let strikeNo: StrikeNo | null = null;
    let scene: string | null;
    let realActivation = true;
    if (event.type === 'state_changed') {
      trigger = 'scene_activated';
      scene = event.entity_id;
      realActivation = isSceneActivation(event.old_state?.state, event.new_state.state);
    } else {
      const timer = event.type === 'timer_expired' ? TIMER_TRIGGERS[event.timerKey] : undefined;
      trigger = timer?.trigger ?? 'system';
      strikeNo = timer?.strikeNo ?? null;
      const active = state(`sensor.${LOCATION}_active_scene` as keyof HAEntities)?.state;
      scene = active ? `scene.${active}` : null;
    }

    const halloweenScene = inArea(HALLOWEEN_SCENE_LABEL)[0] ?? null;
    const now = new Date();
    const nowMs = now.getTime();
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    return {
      trigger,
      strikeNo,
      automationEnabled: state(`input_boolean.${LOCATION}_automation_lights_enabled` as keyof HAEntities)?.state === 'on',
      realActivation,
      halloweenActive: halloweenScene !== null && scene === halloweenScene,
      featureLights: inArea(FEATURE_LABEL).filter(e => e.startsWith('light.')),
      driftColour: DRIFT_COLOURS[Math.floor(nowMs / DRIFT_PERIOD_MS) % DRIFT_COLOURS.length],
      msToNextDrift: DRIFT_PERIOD_MS - (nowMs % DRIFT_PERIOD_MS) + DRIFT_BOUNDARY_OFFSET_MS,
      // Lights only run in the evening, so "before the cutoff" means between noon and 20:30.
      lightningOpen: minutesNow >= 12 * 60 && minutesNow < LIGHTNING_CUTOFF.hour * 60 + LIGHTNING_CUTOFF.minute,
      nextStrikeMs: LIGHTNING_MIN_GAP_MS + Math.floor(Math.random() * (LIGHTNING_MAX_GAP_MS - LIGHTNING_MIN_GAP_MS)),
    };
  },

  reduce: (ctx) => {
    const { trigger, strikeNo, automationEnabled, realActivation, halloweenActive, featureLights, driftColour, msToNextDrift, lightningOpen, nextStrikeMs } = ctx;
    const phaseTimers = STRIKE_TIMERS[strikeNo ?? 1];
    const reason = strikeNo === 2 ? 'lightning_echo' : 'lightning_strike';
    const isTimer = trigger !== 'scene_activated' && trigger !== 'system';
    const cancelAll: Action[] = Object.values(TIMERS).map(timerKey => ({ type: 'timer.cancel' as const, timerKey }));
    const setAll = (rgb_color: [number, number, number], brightness: number, transition: number): Action[] =>
      featureLights.map(entity_id => HomeAssistant.light.turn_on({ entity_id }, { rgb_color, brightness, transition }));
    const scheduleNextStrike: Action = { type: 'timer.start', timerKey: TIMERS.strike, delayMs: nextStrikeMs };

    if (trigger === 'scene_activated' && !realActivation) {
      return { decision: 'no_action', reason: 'scene_reloaded_not_activated', actions: [] };
    }

    if (!automationEnabled) {
      return isTimer
        ? { decision: 'stop_animation', reason: 'automation_disabled', actions: cancelAll }
        : { decision: 'no_action', reason: 'automation_disabled', actions: [] };
    }

    if (!halloweenActive) {
      if (trigger === 'system') {
        return { decision: 'no_action', reason: 'halloween_not_active', actions: [] };
      }
      // Any other scene (including off) ends the animation; a late timer must never relight the garden.
      return { decision: 'stop_animation', reason: isTimer ? 'halloween_no_longer_active' : 'other_scene_activated', actions: cancelAll };
    }

    if (featureLights.length === 0) {
      return { decision: 'stop_animation', reason: 'no_feature_lights', actions: cancelAll };
    }

    switch (trigger) {
      case 'scene_activated':
      case 'system':
        return {
          decision: 'start_animation',
          reason: trigger === 'system' ? 'startup_with_halloween_active' : 'halloween_scene_activated',
          actions: [
            ...cancelAll,
            { type: 'timer.start', timerKey: TIMERS.drift, delayMs: msToNextDrift },
            ...(lightningOpen ? [scheduleNextStrike] : []),
          ],
        };

      case 'drift':
        return {
          decision: 'drift',
          reason: `drift_to_${driftColour.name}`,
          actions: [
            ...setAll(driftColour.rgb, driftColour.brightness, DRIFT_TRANSITION_S),
            { type: 'timer.start', timerKey: TIMERS.drift, delayMs: msToNextDrift },
          ],
        };

      case 'strike':
        // Only a new bolt respects the cutoff; an echo always follows its first strike.
        if (strikeNo === 1 && !lightningOpen) {
          return { decision: 'no_action', reason: 'past_lightning_cutoff', actions: [] };
        }
        return {
          decision: 'lightning_flicker',
          reason,
          actions: [
            ...setAll(STRIKE_COLOUR, FLICKER_BRIGHTNESS, 0),
            { type: 'timer.start', timerKey: phaseTimers.flicker_end, delayMs: FLICKER_MS },
          ],
        };

      case 'flicker_end':
        return {
          decision: 'lightning_flicker_end',
          reason,
          actions: [
            ...setAll(driftColour.rgb, driftColour.brightness, 0),
            { type: 'timer.start', timerKey: phaseTimers.flash, delayMs: FLICKER_TO_FLASH_MS - FLICKER_MS },
          ],
        };

      case 'flash':
        return {
          decision: 'lightning_flash',
          reason,
          actions: [
            ...setAll(STRIKE_COLOUR, FLASH_BRIGHTNESS, 0),
            { type: 'timer.start', timerKey: phaseTimers.restore, delayMs: FLASH_MS },
          ],
        };

      case 'restore': {
        const restore = setAll(driftColour.rgb, driftColour.brightness, 0);
        if (strikeNo === 1) {
          // Echo starts ECHO_AFTER_MS after the first strike began.
          return {
            decision: 'lightning_restore',
            reason: 'echo_scheduled',
            actions: [...restore, { type: 'timer.start', timerKey: TIMERS.echo, delayMs: ECHO_AFTER_MS - FLICKER_TO_FLASH_MS - FLASH_MS }],
          };
        }
        return {
          decision: 'lightning_restore',
          reason: lightningOpen ? 'next_bolt_scheduled' : 'past_lightning_cutoff',
          actions: [...restore, ...(lightningOpen ? [scheduleNextStrike] : [])],
        };
      }
    }
  },
});
