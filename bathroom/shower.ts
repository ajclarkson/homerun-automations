import { defineAutomation, abort, type Action, type HAState } from '@ajclarkson/homerun';
import {
  HUMIDITY_ENTITY, SHOWER_ENTITY, SHOWER_TOPIC,
  SHOWER_MAX_ON_TIMER, SHOWER_END_CONFIRM_TIMER, MAX_SHOWER_ON_MS,
  MIN_RISE, MAX_RISE, MIN_END_DROP, MAX_END_DROP,
  MIN_END_CONFIRM_MIN, MAX_END_CONFIRM_MIN,
  clamp, readFinite, readShower, minutesToMs,
} from './bathroom-steam.js';

const CHANGE_ENTITY = 'sensor.bathroom_humidity_change_5m';
const MAX_ENTITY = 'sensor.bathroom_humidity_max_10m';
const RISE_HELPER = 'input_number.bathroom_automation_shower_rise';
const DROP_HELPER = 'input_number.bathroom_automation_shower_end_drop';
const CONFIRM_HELPER = 'input_number.bathroom_automation_shower_end_confirm';

type ShowerTrigger = 'humidity' | 'statistic' | 'max_on_expired' | 'end_confirm_expired' | 'start_up';

interface ShowerContext {
  trigger: ShowerTrigger;
  showerOn: boolean;
  humidity: number;
  change5m: number;
  max10m: number;
  rise: number;
  drop: number;
  endConfirmMs: number;
  risingFast: boolean;
  fallenFromPeak: boolean;
  /**
   * Checked when end_confirm expires. The original drop line cannot be re-checked
   * then: the sensor reports on change, so after a quiet 5 min the 10-min max
   * has usually shrunk to the latest sample. Silence plus no new rise is the
   * evidence the steam has stopped; a real resumption is a rise and cancels the timer.
   */
  notClimbing: boolean;
  /** Fell below the peak on this very report, as opposed to having already been below it. */
  freshlyFallen: boolean;
  /** The previous report was already past the drop line, so a rise now is a resumed shower. */
  wasFallen: boolean;
}

interface ShowerEvent {
  type: string;
  timerKey?: string;
  entity_id?: string;
  old_state?: { state: string };
}

function triggerOf(event: ShowerEvent): ShowerTrigger {
  if (event.type === 'timer_expired') {
    return event.timerKey === SHOWER_MAX_ON_TIMER ? 'max_on_expired' : 'end_confirm_expired';
  }
  if (event.type === 'state_changed') {
    return event.entity_id === HUMIDITY_ENTITY ? 'humidity' : 'statistic';
  }
  return 'start_up';
}

/** Humidity is a percentage; anything outside 0-100 is a faulty sensor, not a steamy room. */
function validPercent(value: number | null): value is number {
  return value !== null && value >= 0 && value <= 100;
}

function buildContext(state: HAState, event: ShowerEvent) {
  const humidity = readFinite(state, HUMIDITY_ENTITY);
  if (!validPercent(humidity)) return abort(`humidity_unavailable:${HUMIDITY_ENTITY}`);
  const max10m = readFinite(state, MAX_ENTITY);
  if (!validPercent(max10m)) return abort(`humidity_unavailable:${MAX_ENTITY}`);

  // HA reports a single-sample window as change 0, so `unknown` or `unavailable`
  // means the statistic is broken, never "no change".
  const change5m = readFinite(state, CHANGE_ENTITY);
  if (change5m === null || Math.abs(change5m) > 100) return abort(`humidity_unavailable:${CHANGE_ENTITY}`);

  const riseRaw = readFinite(state, RISE_HELPER);
  if (riseRaw === null) return abort(`helper_unavailable:${RISE_HELPER}`);
  const dropRaw = readFinite(state, DROP_HELPER);
  if (dropRaw === null) return abort(`helper_unavailable:${DROP_HELPER}`);
  const confirmRaw = readFinite(state, CONFIRM_HELPER);
  if (confirmRaw === null) return abort(`helper_unavailable:${CONFIRM_HELPER}`);

  const shower = readShower(state);
  if (shower.kind === 'unavailable') return abort(`shower_state_unavailable:${shower.raw}`);

  const rise = clamp(riseRaw, MIN_RISE, MAX_RISE);
  const drop = clamp(dropRaw, MIN_END_DROP, MAX_END_DROP);
  const endConfirmMs = minutesToMs(clamp(confirmRaw, MIN_END_CONFIRM_MIN, MAX_END_CONFIRM_MIN));

  const trigger = triggerOf(event);
  const previous = trigger === 'humidity' ? Number(event.old_state?.state) : NaN;
  const fallenFromPeak = humidity <= max10m - drop;
  // Statistic events carry no previous humidity; a rise that begins while the room is
  // still below the line is by definition a rise out of a dip.
  const wasFallen = trigger === 'humidity' ? Number.isFinite(previous) && previous <= max10m - drop : fallenFromPeak;

  return {
    trigger, showerOn: shower.kind === 'on',
    humidity, change5m, max10m, rise, drop, endConfirmMs,
    // The statistics sensors update after the humidity event that feeds them, so on
    // a humidity event change_5m is still the previous report's. Rises are judged
    // only on the statistic events that follow; the humidity event handles falls.
    risingFast: trigger !== 'humidity' && change5m >= rise,
    fallenFromPeak,
    notClimbing: change5m < rise,
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
    return ctx.notClimbing
      ? endShower('shower_ended')
      : { decision: 'no_action', reason: 'shower_running', actions: [] };
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
    { type: 'state_changed', entity: CHANGE_ENTITY as keyof HAEntities },
    { type: 'state_changed', entity: MAX_ENTITY as keyof HAEntities },
    { type: 'timer_expired', timerKey: SHOWER_MAX_ON_TIMER },
    { type: 'timer_expired', timerKey: SHOWER_END_CONFIRM_TIMER },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => buildContext(state, event as ShowerEvent),

  reduce: (ctx) => (ctx.showerOn ? reduceShowerOn(ctx) : reduceShowerOff(ctx)),
});
