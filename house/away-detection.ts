import { defineAutomation, abort, type Action } from '@ajclarkson/homerun';
import type { TriggerEvent } from '@ajclarkson/homerun';

const DOOR_WINDOW_MS = 15 * 60 * 1000;
const MODIFIER_ENTITY = 'input_select.house_active_mode_modifier';

const VACATION_THRESHOLD_HELPER = 'input_number.house_automation_vacation_threshold_hours';
const MIN_VACATION_THRESHOLD_HOURS = 1;
const MAX_VACATION_THRESHOLD_HOURS = 168;
const VACATION_PROMOTION_TIMER = 'house:house_mode:vacation_promotion';

// Threshold can be set up to a week; give the timer delay room above that.
const MIN_TIMER_DELAY_MS = 250;
const MAX_TIMER_DELAY_MS = 8 * 24 * 60 * 60 * 1000;

export default defineAutomation({
  id: 'house:away_detection',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'state_changed', entity: 'zone.home' },
    { type: 'state_changed', entity: MODIFIER_ENTITY },
    { type: 'timer_expired', timerKey: VACATION_PROMOTION_TIMER },
    { type: 'on_start' },
  ],

  context: (state, _ha, event: TriggerEvent) => {
    const zoneHome = state('zone.home');
    const personCount = parseInt(zoneHome?.state ?? '', 10);
    if (!Number.isFinite(personCount)) {
      return abort(`zone_home_unavailable:${zoneHome?.state}`);
    }

    const houseModeEntity = state('sensor.house_active_mode');
    const houseMode = houseModeEntity?.state;
    if (!houseMode) {
      return abort('house_mode_unavailable');
    }

    const doorsEntity = state('binary_sensor.external_doors_state');
    if (!doorsEntity) {
      return abort('doors_entity_missing');
    }

    const modifier = state(MODIFIER_ENTITY)?.state;
    if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
      return abort(`modifier_unavailable:${modifier}`);
    }

    const doorsLastChangedMs = Date.parse(doorsEntity.last_changed);
    const timeSinceDoorsChangedMs = Number.isFinite(doorsLastChangedMs)
      ? Date.now() - doorsLastChangedMs
      : Infinity;

    const noneHome = personCount === 0;
    const doorRecentlyChanged = timeSinceDoorsChangedMs <= DOOR_WINDOW_MS;
    const sitterActive = modifier === 'sitter';

    const sitterJustLeft = event.type === 'state_changed'
      && event.entity_id === MODIFIER_ENTITY
      && event.old_state?.state === 'sitter'
      && modifier !== 'sitter';

    // Away escalating to vacation is a background, duration-based check — it
    // reads the house mode sensor's own last_changed rather than tracking a
    // separate "when did away start" flag.
    const thresholdRaw = parseFloat(state(VACATION_THRESHOLD_HELPER as keyof HAEntities)?.state ?? '');
    const thresholdHours = Number.isFinite(thresholdRaw)
      ? Math.min(Math.max(thresholdRaw, MIN_VACATION_THRESHOLD_HOURS), MAX_VACATION_THRESHOLD_HOURS)
      : null; // helper not yet configured — promotion stays disabled rather than guessing a value

    const awaySinceMs = houseMode === 'away' ? Date.parse(houseModeEntity?.last_changed ?? '') : NaN;
    // Unknown "since when" never promotes — safer to stay in away than to
    // guess the house has been empty long enough when we can't tell.
    const awayElapsedMs = Number.isFinite(awaySinceMs) ? Date.now() - awaySinceMs : 0;

    const vacationEligible = houseMode === 'away' && thresholdHours !== null
      && awayElapsedMs >= thresholdHours * 60 * 60 * 1000;

    const vacationTimerValidUntilMs = (houseMode === 'away' && thresholdHours !== null && !vacationEligible && Number.isFinite(awaySinceMs))
      ? awaySinceMs + thresholdHours * 60 * 60 * 1000
      : null;

    return {
      noneHome,
      doorRecentlyChanged,
      houseMode,
      sitterActive,
      sitterJustLeft,
      vacationEligible,
      vacationTimerValidUntilMs,
    };
  },

  reduce: (ctx) => {
    const { noneHome, doorRecentlyChanged, houseMode, sitterActive, sitterJustLeft, vacationEligible, vacationTimerValidUntilMs } = ctx;
    const actions: Action[] = [];
    let decision = 'uninitialised';
    let reason = 'uninitialised';

    if (vacationTimerValidUntilMs !== null) {
      const delayMs = Math.min(Math.max(vacationTimerValidUntilMs - Date.now(), MIN_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
      actions.push({ type: 'timer.start', timerKey: VACATION_PROMOTION_TIMER, delayMs });
    } else {
      actions.push({ type: 'timer.cancel', timerKey: VACATION_PROMOTION_TIMER });
    }

    if (sitterActive && (houseMode === 'away' || houseMode === 'vacation')) {
      decision = 'set_normal';
      reason = 'sitter_present';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' });
    } else if (sitterActive) {
      decision = 'no_action';
      reason = 'sitter_present';
    } else if (noneHome && sitterJustLeft && houseMode !== 'away') {
      decision = 'set_away';
      reason = 'sitter_mode_ended_house_empty';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' });
    } else if (noneHome && vacationEligible) {
      decision = 'set_vacation';
      reason = 'away_duration_exceeded';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'vacation', impliesEntity: 'sensor.house_active_mode' });
    } else if (noneHome && doorRecentlyChanged) {
      decision = 'set_away';
      reason = 'all_left_door_recently';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' });
    } else if (!noneHome && houseMode === 'away') {
      decision = 'set_normal';
      reason = 'someone_returned';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' });
    } else if (noneHome) {
      decision = 'no_action';
      reason = 'no_door_event';
    } else {
      decision = 'no_action';
      reason = 'not_in_away_mode';
    }

    return {
      decision,
      reason,
      actions,
    };
  },
});
