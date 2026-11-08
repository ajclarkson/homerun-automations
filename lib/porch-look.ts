// The porch's saved look, kept as compact JSON in an input_text so it survives HA restarts and so the
// fade-back can be a plain light.turn_on (the bulb snaps on scene.turn_on but fades on light.turn_on).
// Effects are never part of a look: the porch bulb's on-bulb effects turn it off while HA reports it on.
import type { Action } from '@ajclarkson/homerun';
import { clamp } from './clamp.js';

export const MIN_KELVIN = 2000; // the bulb's supported range
export const MAX_KELVIN = 9009;
export const MIN_BRIGHTNESS = 1;
export const MAX_BRIGHTNESS = 255;
export const MAX_LOOK_CHARS = 255; // input_text maximum

export type Look =
  | { state: 'off' }
  | { state: 'on'; brightness: number; kelvin: number }
  | { state: 'on'; brightness: number; xy: [number, number] };

/** A look plus, while a fade-back is under way, the epoch ms at which that fade (and its margin) ends. */
export interface SavedLook { look: Look; fadeEndsMs: number | null }

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isXy = (v: unknown): v is [number, number] => Array.isArray(v) && v.length === 2 && v.every(finite);

/** Reads the porch's current look from HA attributes. A string result names why it can't be saved. */
export function readLook(state: string, attributes: Record<string, unknown> = {}): Look | string {
  if (state === 'off') return { state: 'off' };
  if (state !== 'on') return `porch_state_unexpected:${state}`;
  const { brightness, color_mode: colorMode, color_temp_kelvin: kelvin, xy_color: xy } = attributes;
  if (!finite(brightness)) return 'porch_brightness_missing';
  const level = clamp(Math.round(brightness), MIN_BRIGHTNESS, MAX_BRIGHTNESS);
  if (colorMode === 'color_temp') {
    return finite(kelvin) ? { state: 'on', brightness: level, kelvin: clamp(Math.round(kelvin), MIN_KELVIN, MAX_KELVIN) }
      : 'porch_kelvin_missing';
  }
  return isXy(xy) ? { state: 'on', brightness: level, xy: [clamp(xy[0], 0, 1), clamp(xy[1], 0, 1)] }
    : 'porch_xy_missing';
}

export function serializeLook(look: Look, fadeEndsMs: number | null = null): string {
  const json = JSON.stringify(fadeEndsMs === null ? look : { ...look, fadeEndsMs });
  if (json.length > MAX_LOOK_CHARS) throw new Error(`porch look is ${json.length} chars, over ${MAX_LOOK_CHARS}: ${json}`);
  return json;
}

/** Null for anything that is not a complete, in-range look: the caller treats that as "no saved look". */
export function parseLook(raw: string | undefined): SavedLook | null {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw ?? ''); } catch { return null; }
  if (parsed === null || typeof parsed !== 'object') return null;
  const fadeEndsMs = finite(parsed.fadeEndsMs) ? parsed.fadeEndsMs : null;
  if (parsed.state === 'off') return { look: { state: 'off' }, fadeEndsMs };
  if (parsed.state !== 'on' || !finite(parsed.brightness)) return null;
  const brightness = clamp(Math.round(parsed.brightness), MIN_BRIGHTNESS, MAX_BRIGHTNESS);
  if (finite(parsed.kelvin)) return { look: { state: 'on', brightness, kelvin: clamp(Math.round(parsed.kelvin), MIN_KELVIN, MAX_KELVIN) }, fadeEndsMs };
  if (isXy(parsed.xy)) return { look: { state: 'on', brightness, xy: [clamp(parsed.xy[0], 0, 1), clamp(parsed.xy[1], 0, 1)] }, fadeEndsMs };
  return null;
}

/** The action that fades the porch to a saved look (plain light services: they fade, scenes snap). */
export function lookAction(porch: string, look: Look, transition: number): Action {
  const target = { entity_id: porch };
  if (look.state === 'off') return { type: 'ha.call_service', domain: 'light', service: 'turn_off', target, data: { transition } };
  const colour = 'kelvin' in look ? { color_temp_kelvin: look.kelvin } : { xy_color: look.xy };
  return { type: 'ha.call_service', domain: 'light', service: 'turn_on', target, data: { brightness: look.brightness, ...colour, transition } };
}

export const setLook = (helper: string, value: string): Action =>
  ({ type: 'ha.call_service', domain: 'input_text', service: 'set_value', target: { entity_id: helper }, data: { value } });
