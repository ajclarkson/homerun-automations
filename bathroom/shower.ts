import { defineAutomation, abort, type Action, type HAState } from '@ajclarkson/homerun';
import {
  HUMIDITY_ENTITY, SHOWER_ENTITY, SHOWER_TOPIC,
  SHOWER_MAX_ON_TIMER, SHOWER_END_CONFIRM_TIMER, MAX_SHOWER_ON_MS,
  MIN_RISE, MAX_RISE, MIN_ABOVE_BASELINE, MAX_ABOVE_BASELINE,
  SATURATED_LEVEL, MIN_SATURATED_STEP, MAX_STEP_GAP_MINS, MIN_END_DROP, MAX_END_DROP,
  MIN_END_CONFIRM_MIN, MAX_END_CONFIRM_MIN,
  clamp, readFinite, readShower, minutesToMs,
} from './bathroom-steam.js';

const BASELINE_ENTITY = 'sensor.bathroom_humidity_baseline';
const ABOVE_HELPER = 'input_number.bathroom_automation_shower_above_baseline';
const MAX_ENTITY = 'sensor.bathroom_humidity_max_10m';
const RISE_HELPER = 'input_number.bathroom_automation_shower_rise';
const DROP_HELPER = 'input_number.bathroom_automation_shower_end_drop';
const CONFIRM_HELPER = 'input_number.bathroom_automation_shower_end_confirm';

type ShowerTrigger = 'humidity' | 'max_on_expired' | 'end_confirm_expired' | 'start_up';

interface ShowerContext {
  trigger: ShowerTrigger;
  showerOn: boolean;
  humidity: number;
  max10m: number;
  baseline: number;
  /** New minus old report; null off a humidity event, where no step exists. */
  step: number | null;
  gapMins: number | null;
  requiredStep: number;
  aboveBaseline: number;
  aboveBaselineOk: boolean;
  rise: number;
  aboveBaselineMin: number;
  drop: number;
  endConfirmMs: number;
  risingFast: boolean;
  fallenFromPeak: boolean;
  /** Fell below the peak on this very report, as opposed to having already been below it. */
  freshlyFallen: boolean;
  /** The previous report was already past the drop line, so a rise now is a resumed shower. */
  wasFallen: boolean;
}

interface ShowerEvent {
  type: string;
  timerKey?: string;
  entity_id?: string;
  old_state?: { state: string; last_changed?: string };
  new_state?: { state: string; last_changed?: string };
}

function triggerOf(event: ShowerEvent): ShowerTrigger {
  if (event.type === 'timer_expired') {
    return event.timerKey === SHOWER_MAX_ON_TIMER ? 'max_on_expired' : 'end_confirm_expired';
  }
  return event.type === 'state_changed' ? 'humidity' : 'start_up';
}

/** Humidity is a percentage; anything outside 0-100 is a faulty sensor, not a steamy room. */
function validPercent(value: number | null): value is number {
  return value !== null && value >= 0 && value <= 100;
}

interface Step { old: number; step: number; gapMins: number }

/** The step between this report and the previous one, with the time between them. */
function readStep(event: ShowerEvent): Step | { abortReason: string } {
  const old = Number(event.old_state?.state);
  const now = Number(event.new_state?.state);
  if (event.old_state?.state === undefined || !validPercent(Number.isFinite(old) ? old : null)) {
    return { abortReason: `humidity_previous_unavailable:${event.old_state?.state ?? 'missing'}` };
  }
  if (!validPercent(Number.isFinite(now) ? now : null)) return { abortReason: `humidity_unavailable:${HUMIDITY_ENTITY}` };
  const oldAt = Date.parse(event.old_state.last_changed ?? '');
  const newAt = Date.parse(event.new_state?.last_changed ?? '');
  if (!Number.isFinite(oldAt) || !Number.isFinite(newAt)) return { abortReason: 'humidity_timestamp_invalid' };
  return { old, step: now - old, gapMins: Math.max((newAt - oldAt) / 60_000, 0) };
}

/** Near saturation a real shower adds only a few points, so the bar drops and baseline no longer matters. */
function judgeRise(s: Step, rise: number, aboveBaseline: number, aboveBaselineMin: number) {
  const saturated = s.old >= SATURATED_LEVEL;
  const requiredStep = saturated ? Math.max(MIN_SATURATED_STEP, rise - 2) : rise;
  const aboveBaselineOk = saturated || aboveBaseline >= aboveBaselineMin;
  const risingFast = s.step >= requiredStep && s.gapMins <= MAX_STEP_GAP_MINS && aboveBaselineOk;
  return { requiredStep, aboveBaselineOk, risingFast };
}

function buildContext(state: HAState, event: ShowerEvent) {
  const humidity = readFinite(state, HUMIDITY_ENTITY);
  if (!validPercent(humidity)) return abort(`humidity_unavailable:${HUMIDITY_ENTITY}`);
  const max10m = readFinite(state, MAX_ENTITY);
  if (!validPercent(max10m)) return abort(`humidity_unavailable:${MAX_ENTITY}`);
  const baseline = readFinite(state, BASELINE_ENTITY);
  if (!validPercent(baseline)) return abort(`humidity_unavailable:${BASELINE_ENTITY}`);

  const riseRaw = readFinite(state, RISE_HELPER);
  if (riseRaw === null) return abort(`helper_unavailable:${RISE_HELPER}`);
  const aboveRaw = readFinite(state, ABOVE_HELPER);
  if (aboveRaw === null) return abort(`helper_unavailable:${ABOVE_HELPER}`);
  const dropRaw = readFinite(state, DROP_HELPER);
  if (dropRaw === null) return abort(`helper_unavailable:${DROP_HELPER}`);
  const confirmRaw = readFinite(state, CONFIRM_HELPER);
  if (confirmRaw === null) return abort(`helper_unavailable:${CONFIRM_HELPER}`);

  const shower = readShower(state);
  if (shower.kind === 'unavailable') return abort(`shower_state_unavailable:${shower.raw}`);

  const rise = clamp(riseRaw, MIN_RISE, MAX_RISE);
  const aboveBaselineMin = clamp(aboveRaw, MIN_ABOVE_BASELINE, MAX_ABOVE_BASELINE);
  const drop = clamp(dropRaw, MIN_END_DROP, MAX_END_DROP);
  const endConfirmMs = minutesToMs(clamp(confirmRaw, MIN_END_CONFIRM_MIN, MAX_END_CONFIRM_MIN));
  const trigger = triggerOf(event);
  const aboveBaseline = humidity - baseline;
  const fallenFromPeak = humidity <= max10m - drop;

  // Rises exist only on humidity reports; timers and start-up carry no step.
  let step: number | null = null;
  let gapMins: number | null = null;
  let wasFallen = fallenFromPeak;
  let judged = { requiredStep: rise, aboveBaselineOk: false, risingFast: false };
  if (trigger === 'humidity') {
    const read = readStep(event);
    if ('abortReason' in read) return abort(read.abortReason);
    ({ step, gapMins } = read);
    judged = judgeRise(read, rise, aboveBaseline, aboveBaselineMin);
    wasFallen = read.old <= max10m - drop;
  }

  return {
    trigger, showerOn: shower.kind === 'on',
    humidity, max10m, baseline, step, gapMins, rise, aboveBaselineMin, aboveBaseline, drop, endConfirmMs,
    ...judged,
    fallenFromPeak,
    // Only a humidity report can newly cross the line (a falling max only moves
    // it further away), so the end-confirm timer starts there and nowhere else.
    freshlyFallen: trigger === 'humidity' && fallenFromPeak && !wasFallen,
    wasFallen,
  };
}

const publishShower = (payload: 'ON' | 'OFF'): Action => ({
  type: 'mqtt.publish', topic: SHOWER_TOPIC, payload, retain: true, impliesEntity: SHOWER_ENTITY,
});
const startTimer = (timerKey: string, delayMs: number): Action => ({
  type: 'timer.start', timerKey, delayMs: clamp(delayMs, 1_000, MAX_SHOWER_ON_MS),
});
const cancelTimer = (timerKey: string): Action => ({ type: 'timer.cancel', timerKey });

function endShower(reason: string) {
  return {
    decision: 'set_off', reason,
    actions: [publishShower('OFF'), cancelTimer(SHOWER_MAX_ON_TIMER), cancelTimer(SHOWER_END_CONFIRM_TIMER)],
  };
}

function reduceShowerOff(ctx: ShowerContext) {
  if (ctx.trigger === 'max_on_expired' || ctx.trigger === 'end_confirm_expired') {
    return { decision: 'no_action', reason: 'no_shower', actions: [] };
  }
  if (ctx.risingFast) {
    return {
      decision: 'set_on', reason: 'shower_started',
      actions: [publishShower('ON'), startTimer(SHOWER_MAX_ON_TIMER, MAX_SHOWER_ON_MS)],
    };
  }
  return { decision: 'no_action', reason: 'no_shower', actions: [] };
}

function reduceShowerOn(ctx: ShowerContext) {
  if (ctx.trigger === 'max_on_expired') return endShower('shower_max_duration');
  if (ctx.trigger === 'end_confirm_expired') {
    // No re-check of the drop line: after a quiet 5 min the sensor's 10-min max has shrunk to
    // the latest sample. A genuine resumption is a rise, which cancels this timer.
    return endShower('shower_ended');
  }
  if (ctx.risingFast) {
    return {
      decision: 'no_action',
      reason: ctx.wasFallen ? 'shower_resumed' : 'shower_running',
      actions: [cancelTimer(SHOWER_END_CONFIRM_TIMER)],
    };
  }
  if (ctx.freshlyFallen) {
    return {
      decision: 'no_action', reason: 'shower_end_pending',
      actions: [startTimer(SHOWER_END_CONFIRM_TIMER, ctx.endConfirmMs)],
    };
  }
  if (ctx.trigger === 'start_up') {
    // Timers do not survive a restart, so re-arm the cap or a stale ON could stick.
    const actions = [startTimer(SHOWER_MAX_ON_TIMER, MAX_SHOWER_ON_MS)];
    if (ctx.fallenFromPeak) actions.push(startTimer(SHOWER_END_CONFIRM_TIMER, ctx.endConfirmMs));
    return { decision: 'no_action', reason: ctx.fallenFromPeak ? 'shower_end_pending' : 'shower_running', actions };
  }
  return {
    decision: 'no_action',
    reason: ctx.fallenFromPeak ? 'shower_end_pending' : 'shower_running',
    actions: [],
  };
}

export default defineAutomation<ShowerContext>({
  id: 'bathroom:shower',
  location: 'bathroom',
  subsystem: 'shower',

  triggers: [
    { type: 'state_changed', entity: HUMIDITY_ENTITY as keyof HAEntities },
    { type: 'timer_expired', timerKey: SHOWER_MAX_ON_TIMER },
    { type: 'timer_expired', timerKey: SHOWER_END_CONFIRM_TIMER },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => buildContext(state, event as ShowerEvent),

  reduce: (ctx) => (ctx.showerOn ? reduceShowerOn(ctx) : reduceShowerOff(ctx)),
});
