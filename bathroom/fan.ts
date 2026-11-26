import { defineAutomation, abort, type Action, type DeclaredDecision, type HAState } from '@ajclarkson/homerun';
import {
  SHOWER_ENTITY, HUMIDITY_ENTITY,
  FAN_MIN_RUN_TIMER, FAN_MAX_RUN_TIMER,
  MIN_FAN_MIN_RUN_MIN, MAX_FAN_MIN_RUN_MIN, MIN_FAN_MAX_RUN_MIN, MAX_FAN_MAX_RUN_MIN,
  MIN_FAN_MARGIN, MAX_FAN_MARGIN,
  readFinite, readShower, minutesToMs,
} from '../lib/bathroom/steam.js';
import { clamp } from '../lib/clamp.js';

const FAN = 'switch.bathroom_fan_extractor';
const ENABLED = 'input_boolean.bathroom_automation_fan_enabled';
const BASELINE = 'sensor.bathroom_humidity_baseline';
const MARGIN_HELPER = 'input_number.bathroom_automation_fan_humidity_margin';
const MIN_RUN_HELPER = 'input_number.bathroom_automation_fan_min_run';
const MAX_RUN_HELPER = 'input_number.bathroom_automation_fan_max_run';

// Ownership: a retained flag that is ON only while this controller's own
// turn-on is the reason the fan runs. The homerun API has no persistent store
// and timers die with the process, so the flag has to live in HA via MQTT.
export const AUTO_TOPIC = 'bathroom/fan/auto';
export const AUTO_ENTITY = 'binary_sensor.bathroom_fan_auto';

// A ZBMini relay has been seen to report ON and then OFF within milliseconds of our own turn_on.
// An off inside START_BOUNCE_WINDOW_MS of the auto flag going ON, while the shower runs, is that
// failure and not a person at the switch. The retry is delayed by RETRY_DELAY_MS so the retry's own
// bounce lands after that delay: the time since the flag went ON then tells the first bounce
// (before the delay: retry) from the second (after it: give up). That is how "once" is guaranteed
// without timer visibility in context or a new entity.
export const FAN_RETRY_TIMER = 'bathroom:fan:start_retry';
export const START_BOUNCE_WINDOW_MS = 10_000;
export const RETRY_DELAY_MS = 2_000;

// Starting or stopping the fan is `acted`. Disabled and not-auto-started are `declined` only when a
// shower just started (the person expected the fan); on any other trigger they are `_idle` noise,
// as are the holding states and the fan's own bookkeeping.
export const FAN_REASONS = {
  fan_on_shower_started: { outcome: 'acted' },
  fan_retry_after_bounce: { outcome: 'acted' },
  fan_start_failed: { outcome: 'declined' },
  fan_off_max_run: { outcome: 'acted' },
  fan_off_humidity_normal: { outcome: 'acted' },
  automation_disabled: { outcome: 'declined' },
  fan_not_auto_started: { outcome: 'declined' },
  automation_disabled_idle: { outcome: 'ignored' },
  fan_not_auto_started_idle: { outcome: 'ignored' },
  fan_idle: { outcome: 'ignored' },
  fan_holding_min_run: { outcome: 'ignored' },
  fan_holding_humidity_high: { outcome: 'ignored' },
  fan_run_extended: { outcome: 'ignored' },
} as const;

type FanDecision = DeclaredDecision<typeof FAN_REASONS>;
type FanReason = keyof typeof FAN_REASONS;

type FanTrigger = 'shower_started' | 'shower_ended' | 'min_run_expired' | 'max_run_expired' | 'retry_expired' | 'fan_turned_off' | 'other';

interface FanContext {
  trigger: FanTrigger;
  enabled: boolean;
  fanOn: boolean;
  /** This controller turned the fan on, so it may turn it off. */
  autoStarted: boolean;
  showerOn: boolean;
  /** Milliseconds since the auto flag went ON; 0 unless this controller owns the fan. */
  msSinceAutoOn: number;
  /** Owned, shower running, and the fan went off before the retry delay: the first bounce. */
  firstBounceWindow: boolean;
  /** Owned, shower running, and the fan went off after the retry delay but inside the window: the retry bounced. */
  retryBounceWindow: boolean;
  humidity: number;
  baseline: number;
  margin: number;
  humidityNormal: boolean;
  minRunMs: number;
  maxRunMs: number;
  /** Minutes since the shower sensor last changed; once the shower is off that is the shower end. */
  minsSinceShowerChange: number;
  minRunElapsed: boolean;
  isStartUp: boolean;
}

interface FanEvent {
  type: string;
  timerKey?: string;
  entity_id?: string;
  new_state?: { state: string };
}

function triggerOf(event: FanEvent): FanTrigger {
  if (event.type === 'timer_expired') {
    if (event.timerKey === FAN_RETRY_TIMER) return 'retry_expired';
    return event.timerKey === FAN_MIN_RUN_TIMER ? 'min_run_expired' : 'max_run_expired';
  }
  if (event.type === 'state_changed' && event.entity_id === FAN && event.new_state?.state === 'off') return 'fan_turned_off';
  if (event.type === 'state_changed' && event.entity_id === SHOWER_ENTITY) {
    return event.new_state?.state === 'on' ? 'shower_started' : 'shower_ended';
  }
  return 'other';
}

function readHelper(state: HAState, entity: string, min: number, max: number): number | null {
  const raw = readFinite(state, entity);
  return raw === null ? null : clamp(raw, min, max);
}

function buildContext(state: HAState, event: FanEvent) {
  const enabledRaw = state(ENABLED)?.state;
  if (enabledRaw !== 'on' && enabledRaw !== 'off') return abort(`enabled_unavailable:${enabledRaw ?? 'missing'}`);

  const fanRaw = state(FAN)?.state;
  if (fanRaw !== 'on' && fanRaw !== 'off') return abort(`fan_unavailable:${fanRaw ?? 'missing'}`);

  const autoRaw = state(AUTO_ENTITY)?.state;
  // unknown = never published, which means this controller never started the fan.
  if (autoRaw !== 'on' && autoRaw !== 'off' && autoRaw !== 'unknown') return abort(`fan_auto_flag_unavailable:${autoRaw ?? 'missing'}`);

  const autoChangedAt = Date.parse(state(AUTO_ENTITY)?.last_changed ?? '');
  // Only an owned fan has a meaningful flag timestamp; off/unknown carry none worth checking.
  if (autoRaw === 'on' && !Number.isFinite(autoChangedAt)) return abort(`fan_auto_timestamp_invalid:${AUTO_ENTITY}`);

  const shower = readShower(state);
  if (shower.kind === 'unavailable') return abort(`shower_state_unavailable:${shower.raw}`);

  const humidity = readFinite(state, HUMIDITY_ENTITY);
  if (humidity === null || humidity < 0 || humidity > 100) return abort(`humidity_unavailable:${HUMIDITY_ENTITY}`);
  const baseline = readFinite(state, BASELINE);
  if (baseline === null || baseline < 0 || baseline > 100) return abort(`humidity_unavailable:${BASELINE}`);

  const margin = readHelper(state, MARGIN_HELPER, MIN_FAN_MARGIN, MAX_FAN_MARGIN);
  const minRunMin = readHelper(state, MIN_RUN_HELPER, MIN_FAN_MIN_RUN_MIN, MAX_FAN_MIN_RUN_MIN);
  const maxRunMin = readHelper(state, MAX_RUN_HELPER, MIN_FAN_MAX_RUN_MIN, MAX_FAN_MAX_RUN_MIN);
  if (margin === null) return abort(`helper_unavailable:${MARGIN_HELPER}`);
  if (minRunMin === null) return abort(`helper_unavailable:${MIN_RUN_HELPER}`);
  if (maxRunMin === null) return abort(`helper_unavailable:${MAX_RUN_HELPER}`);

  const changedAt = Date.parse(state(SHOWER_ENTITY)?.last_changed ?? '');
  if (!Number.isFinite(changedAt)) return abort(`shower_timestamp_invalid:${SHOWER_ENTITY}`);
  const minsSinceShowerChange = Math.max((Date.now() - changedAt) / 60_000, 0);

  const trigger = triggerOf(event);
  const autoStarted = autoRaw === 'on';
  const showerOn = shower.kind === 'on';
  const msSinceAutoOn = autoStarted ? Math.max(Date.now() - autoChangedAt, 0) : 0;
  const inBounceScope = trigger === 'fan_turned_off' && autoStarted && showerOn && msSinceAutoOn < START_BOUNCE_WINDOW_MS;

  // The cap can never be shorter than the minimum run, whatever the helpers say.
  const minRunMs = minutesToMs(minRunMin);
  const maxRunMs = Math.max(minutesToMs(maxRunMin), minRunMs);

  return {
    trigger,
    enabled: enabledRaw === 'on',
    fanOn: fanRaw === 'on',
    autoStarted,
    showerOn,
    msSinceAutoOn,
    firstBounceWindow: inBounceScope && msSinceAutoOn < RETRY_DELAY_MS,
    retryBounceWindow: inBounceScope && msSinceAutoOn >= RETRY_DELAY_MS,
    humidity, baseline, margin,
    humidityNormal: humidity <= baseline + margin,
    minRunMs, maxRunMs,
    minsSinceShowerChange,
    minRunElapsed: minsSinceShowerChange >= minRunMin,
    isStartUp: event.type === 'on_start',
  };
}

const publishAuto = (payload: 'ON' | 'OFF'): Action => ({
  type: 'mqtt.publish', topic: AUTO_TOPIC, payload, retain: true, impliesEntity: AUTO_ENTITY,
});
const cancel = (timerKey: string): Action => ({ type: 'timer.cancel', timerKey });
const startTimer = (timerKey: string, delayMs: number): Action => ({
  type: 'timer.start', timerKey, delayMs: clamp(delayMs, 1_000, minutesToMs(MAX_FAN_MAX_RUN_MIN)),
});
const startRetryTimer = (): Action => ({ type: 'timer.start', timerKey: FAN_RETRY_TIMER, delayMs: RETRY_DELAY_MS });
const holdTimers = (): Action[] => [cancel(FAN_MIN_RUN_TIMER), cancel(FAN_MAX_RUN_TIMER)];
const runTimers = (ctx: FanContext): Action[] => [
  startTimer(FAN_MIN_RUN_TIMER, ctx.minRunMs),
  startTimer(FAN_MAX_RUN_TIMER, ctx.maxRunMs),
];

const ignore = (reason: FanReason, actions: Action[] = []): FanDecision => ({ decision: 'no_action', reason, actions });

function stopFan(reason: 'fan_off_max_run' | 'fan_off_humidity_normal'): FanDecision {
  return {
    decision: 'turn_off', reason,
    actions: [
      { type: 'ha.call_service', domain: 'switch', service: 'turn_off', target: { entity_id: FAN } } as Action,
      publishAuto('OFF'), ...holdTimers(),
    ],
  };
}

function reduceFanOff(ctx: FanContext): FanDecision {
  const startsNow = ctx.trigger === 'shower_started' || (ctx.isStartUp && ctx.showerOn);
  if (startsNow && ctx.showerOn) {
    return {
      decision: 'turn_on', reason: 'fan_on_shower_started',
      // Timers restart when the shower ends, so the run is timed from the last shower.
      actions: [
        { type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: FAN } } as Action,
        publishAuto('ON'), ...holdTimers(),
      ],
    };
  }
  // The retry is delayed (see RETRY_DELAY_MS); by then the fan may have been taken over or the shower ended.
  if (ctx.trigger === 'retry_expired' && ctx.autoStarted && ctx.showerOn) {
    return {
      decision: 'turn_on', reason: 'fan_retry_after_bounce',
      actions: [{ type: 'ha.call_service', domain: 'switch', service: 'turn_on', target: { entity_id: FAN } } as Action],
    };
  }
  // The relay bounced our own start: keep ownership and retry once, after the delay.
  if (ctx.firstBounceWindow) return ignore('fan_idle', [startRetryTimer()]);
  // The retry bounced too: stop fighting the relay and say so.
  if (ctx.retryBounceWindow) {
    return { decision: 'no_action', reason: 'fan_start_failed', actions: [publishAuto('OFF'), ...holdTimers()] };
  }
  // Someone switched the fan off by hand: forget ownership so a later manual on is left alone.
  if (ctx.autoStarted) return ignore('fan_idle', [publishAuto('OFF'), ...holdTimers()]);
  return ignore('fan_idle');
}

function reduceFanOnShowerEnded(ctx: FanContext): FanDecision {
  if (ctx.trigger === 'shower_ended') {
    return ignore('fan_holding_min_run', runTimers(ctx));
  }
  if (ctx.trigger === 'max_run_expired') return stopFan('fan_off_max_run');
  if (!ctx.minRunElapsed) return ignore('fan_holding_min_run');
  if (ctx.humidityNormal) return stopFan('fan_off_humidity_normal');
  return ignore('fan_holding_humidity_high');
}

function reduceFanOn(ctx: FanContext): FanDecision {
  if (!ctx.autoStarted) return ignore(ctx.trigger === 'shower_started' ? 'fan_not_auto_started' : 'fan_not_auto_started_idle');
  if (ctx.showerOn) {
    if (ctx.trigger === 'shower_started') return ignore('fan_run_extended', holdTimers());
    return ignore('fan_holding_min_run');
  }
  // A stale retry timer (the fan came back on, or the shower ended meanwhile) has nothing left to do.
  if (ctx.trigger === 'retry_expired') return ignore('fan_idle');
  // Timers do not survive a restart: re-arm both so the fan cannot run forever.
  if (ctx.isStartUp) return ignore('fan_holding_min_run', runTimers(ctx));
  return reduceFanOnShowerEnded(ctx);
}

export default defineAutomation<FanContext, typeof FAN_REASONS>({
  reasons: FAN_REASONS,
  id: 'bathroom:fan',
  location: 'bathroom',
  subsystem: 'fan',

  triggers: [
    { type: 'state_changed', entity: SHOWER_ENTITY as keyof HAEntities },
    { type: 'state_changed', entity: HUMIDITY_ENTITY as keyof HAEntities },
    { type: 'state_changed', entity: BASELINE as keyof HAEntities },
    { type: 'state_changed', entity: FAN as keyof HAEntities },
    { type: 'state_changed', entity: ENABLED as keyof HAEntities },
    { type: 'timer_expired', timerKey: FAN_MIN_RUN_TIMER },
    { type: 'timer_expired', timerKey: FAN_MAX_RUN_TIMER },
    { type: 'timer_expired', timerKey: FAN_RETRY_TIMER },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => buildContext(state, event as FanEvent),

  reduce: (ctx): FanDecision => {
    if (!ctx.enabled) return ignore(ctx.trigger === 'shower_started' ? 'automation_disabled' : 'automation_disabled_idle');
    return ctx.fanOn ? reduceFanOn(ctx) : reduceFanOff(ctx);
  },
});
