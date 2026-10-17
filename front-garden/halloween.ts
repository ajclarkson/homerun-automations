import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';
import type { Action } from '@ajclarkson/homerun';

// Halloween animation for the front garden's feature light(s) — the birch. Runs only while the
// Halloween theme scene is active, layered on top of it:
//   - drift: a fade between purple and sickly green, holding each colour for a while
//   - lightning: every 3–8 minutes a dim flicker then a brighter flash, until 20:30
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

export const LIGHTNING_MIN_GAP_MS = 3 * 60_000;
export const LIGHTNING_MAX_GAP_MS = 8 * 60_000;
// No new strikes from this local time; drift carries on.
export const LIGHTNING_CUTOFF = { hour: 20, minute: 30 };
const STRIKE_COLOUR: [number, number, number] = [200, 215, 255];
const FLICKER_BRIGHTNESS = 110;
const FLASH_BRIGHTNESS = 255;
export const FLICKER_TO_FLASH_MS = 180;
export const FLASH_TO_RESTORE_MS = 300;
const RESTORE_TRANSITION_S = 1.5;

export const TIMERS = {
  drift: `${LOCATION}:halloween_drift`,
  strike: `${LOCATION}:halloween_lightning`,
  flash: `${LOCATION}:halloween_lightning_flash`,
  restore: `${LOCATION}:halloween_lightning_restore`,
} as const;

type HalloweenTrigger = 'scene_activated' | 'drift' | 'strike' | 'flash' | 'restore' | 'system';
const TIMER_TRIGGERS: Record<string, HalloweenTrigger> = {
  [TIMERS.drift]: 'drift',
  [TIMERS.strike]: 'strike',
  [TIMERS.flash]: 'flash',
  [TIMERS.restore]: 'restore',
};

interface HalloweenContext {
  trigger: HalloweenTrigger;
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

const isActivationTimestamp = (state: string | undefined) => !!state && !Number.isNaN(Date.parse(state));

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
    let scene: string | null;
    let realActivation = true;
    if (event.type === 'state_changed') {
      trigger = 'scene_activated';
      scene = event.entity_id;
      realActivation = isActivationTimestamp(event.new_state.state);
    } else {
      trigger = event.type === 'timer_expired' ? TIMER_TRIGGERS[event.timerKey] ?? 'system' : 'system';
      const active = state(`sensor.${LOCATION}_active_scene` as keyof HAEntities)?.state;
      scene = active ? `scene.${active}` : null;
    }

    const halloweenScene = inArea(HALLOWEEN_SCENE_LABEL)[0] ?? null;
    const now = new Date();
    const nowMs = now.getTime();
    const minutesNow = now.getHours() * 60 + now.getMinutes();

    return {
      trigger,
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
    const { trigger, automationEnabled, realActivation, halloweenActive, featureLights, driftColour, msToNextDrift, lightningOpen, nextStrikeMs } = ctx;
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
        if (!lightningOpen) {
          return { decision: 'no_action', reason: 'past_lightning_cutoff', actions: [] };
        }
        return {
          decision: 'lightning_flicker',
          reason: 'lightning_strike',
          actions: [
            ...setAll(STRIKE_COLOUR, FLICKER_BRIGHTNESS, 0),
            { type: 'timer.start', timerKey: TIMERS.flash, delayMs: FLICKER_TO_FLASH_MS },
          ],
        };

      case 'flash':
        return {
          decision: 'lightning_flash',
          reason: 'lightning_strike',
          actions: [
            ...setAll(STRIKE_COLOUR, FLASH_BRIGHTNESS, 0),
            { type: 'timer.start', timerKey: TIMERS.restore, delayMs: FLASH_TO_RESTORE_MS },
          ],
        };

      case 'restore':
        return {
          decision: 'lightning_restore',
          reason: lightningOpen ? 'next_strike_scheduled' : 'past_lightning_cutoff',
          actions: [
            ...setAll(driftColour.rgb, driftColour.brightness, RESTORE_TRANSITION_S),
            ...(lightningOpen ? [scheduleNextStrike] : []),
          ],
        };
    }
  },
});
