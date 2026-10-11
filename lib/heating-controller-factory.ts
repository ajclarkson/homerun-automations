import { defineAutomation, abort, HomeAssistant, type Action } from '@ajclarkson/homerun';

// ---- Types ----

export type HeatingMode = 'minimum' | 'baseline_night' | 'baseline_day' | 'comfort';
export type HeatingSource = 'schedule' | 'manual' | 'house_mode' | 'safety' | 'none';

export type ScheduleContextKey =
  | 'weekday_wfh_adam'
  | 'weekday_wfh_sarah'
  | 'weekend'
  | 'weekday'
  | 'default';

export interface HeatingBlock {
  id?: string;
  start: string; // 'HH:MM'
  end: string;   // 'HH:MM'
  mode: HeatingMode;
  occupiedMode?: HeatingMode;
}

export interface HeatingRoomConfig {
  location: string;
  scheduleConfig: { byContext: Partial<Record<ScheduleContextKey, HeatingBlock[]>> };
  /** Opt out of house-wide heating overrides — the house_heating_enabled gate and
   *  sleep/away/vacation mode forcing (foreign office only). The room's own schedule
   *  and manual override still apply. */
  independent?: boolean;
}

// ---- Constants ----

const VALID_HEATING_MODES = new Set<string>(['minimum', 'baseline_night', 'baseline_day', 'comfort']);

const HOUSE_MODES_AFFECTING_HEATING = ['sleep', 'away', 'vacation'] as const;
type HouseMode = typeof HOUSE_MODES_AFFECTING_HEATING[number];

const HOUSE_MODE_MAP: Record<HouseMode, HeatingMode> = {
  sleep: 'baseline_night',
  away: 'minimum',
  vacation: 'minimum',
};

const SCHEDULE_TIMER_SUFFIX = 'heating:schedule_boundary';
const MANUAL_TIMER_SUFFIX = 'heating:manual_override_expiry';
const WINDOW_GRACE_TIMER_SUFFIX = 'heating:window_open_grace';

const WINDOW_GRACE_HELPER = 'input_number.global_heating_window_open_grace_minutes';
const MIN_WINDOW_GRACE_MINUTES = 0;
const MAX_WINDOW_GRACE_MINUTES = 30;

// Any schedule block can span at most 24h; 25h is a safe ceiling for timer delay.
const MIN_TIMER_DELAY_MS = 250;
const MAX_TIMER_DELAY_MS = 25 * 60 * 60 * 1000;

// ---- Schedule resolution ----

function parseHHMM(hhmm: string): number | null {
  const [h, m] = hhmm.split(':').map(Number);
  if (!Number.isFinite(h) || !Number.isFinite(m)) return null;
  if (h < 0 || h > 23 || m < 0 || m > 59) return null;
  return h * 60 + m;
}

function minutesSinceMidnight(d: Date): number {
  return d.getHours() * 60 + d.getMinutes();
}

function resolveActiveBlock(blocks: HeatingBlock[], now: Date): HeatingBlock | null {
  const nowMins = minutesSinceMidnight(now);
  for (const block of blocks) {
    const s = parseHHMM(block.start);
    const e = parseHHMM(block.end);
    if (s === null || e === null) continue;
    const overnight = e < s;
    const inBlock = overnight ? (nowMins >= s || nowMins < e) : (nowMins >= s && nowMins < e);
    if (inBlock) return block;
  }
  return null;
}

function computeValidUntilMs(block: HeatingBlock, now: Date): number | null {
  const endMins = parseHHMM(block.end);
  if (endMins === null) return null;

  const end = new Date(now);
  end.setSeconds(0, 0);
  const nowMins = minutesSinceMidnight(now);
  if (endMins <= nowMins) end.setDate(end.getDate() + 1);
  end.setHours(Math.floor(endMins / 60), endMins % 60, 0, 0);

  const validUntilMs = end.getTime();
  if (!Number.isFinite(validUntilMs) || validUntilMs <= now.getTime()) return null;
  return validUntilMs;
}

function buildContextKeys(weekday: boolean, wfhAdam: boolean, wfhSarah: boolean): ScheduleContextKey[] {
  const keys: ScheduleContextKey[] = [];
  if (weekday && wfhAdam) keys.push('weekday_wfh_adam');
  if (weekday && wfhSarah) keys.push('weekday_wfh_sarah');
  if (!weekday) keys.push('weekend');
  if (weekday) keys.push('weekday');
  keys.push('default');
  return keys;
}

interface ResolvedSchedule {
  requestedMode: HeatingMode | null;
  validUntilMs: number | null;
  block: HeatingBlock | null;
  contextKey: ScheduleContextKey | null;
}

function resolveSchedule(
  scheduleConfig: HeatingRoomConfig['scheduleConfig'],
  weekday: boolean,
  wfhAdam: boolean,
  wfhSarah: boolean,
  now: Date,
): ResolvedSchedule {
  const { byContext } = scheduleConfig;
  const keys = buildContextKeys(weekday, wfhAdam, wfhSarah);

  let blocks: HeatingBlock[] | null = null;
  let contextKey: ScheduleContextKey | null = null;
  for (const key of keys) {
    if (Array.isArray(byContext[key])) {
      blocks = byContext[key]!;
      contextKey = key;
      break;
    }
  }

  if (!blocks) return { requestedMode: null, validUntilMs: null, block: null, contextKey: null };

  const block = resolveActiveBlock(blocks, now);
  if (!block) return { requestedMode: null, validUntilMs: null, block: null, contextKey };

  return {
    requestedMode: block.mode,
    validUntilMs: computeValidUntilMs(block, now),
    block,
    contextKey,
  };
}

// ---- Reducer helpers ----

function planTimer(timerKey: string, validUntilMs: number | null, nowMs: number): Action[] {
  if (validUntilMs === null) return [];
  const delayMs = Math.min(Math.max(validUntilMs - nowMs, MIN_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
  return [{ type: 'timer.start', timerKey, delayMs }];
}

// ---- Window-open safety debounce ----

interface WindowSafety {
  windowOpen: boolean;
  windowOpenConfirmed: boolean;
  windowOpenPending: boolean;
  windowGraceValidUntilMs: number | null;
}

function resolveWindowSafety(
  windowState: { state: string; last_changed: string } | undefined,
  graceHelperState: string | undefined,
  now: Date,
): WindowSafety {
  const windowOpen = windowState?.state === 'on';
  if (!windowOpen) {
    return { windowOpen: false, windowOpenConfirmed: false, windowOpenPending: false, windowGraceValidUntilMs: null };
  }

  const graceMinutesRaw = parseFloat(graceHelperState ?? '');
  const graceMinutes = Number.isFinite(graceMinutesRaw)
    ? Math.min(Math.max(graceMinutesRaw, MIN_WINDOW_GRACE_MINUTES), MAX_WINDOW_GRACE_MINUTES)
    : MIN_WINDOW_GRACE_MINUTES; // helper unavailable — fail toward the stricter immediate-safety behaviour
  const graceMs = graceMinutes * 60_000;

  const openedAtMs = windowState?.last_changed ? new Date(windowState.last_changed).getTime() : NaN;
  // Unknown open-since time is treated as already past grace — never delay safety on missing data.
  const elapsedMs = Number.isFinite(openedAtMs) ? now.getTime() - openedAtMs : Infinity;

  const windowOpenConfirmed = elapsedMs >= graceMs;
  const windowGraceValidUntilMs = !windowOpenConfirmed && Number.isFinite(openedAtMs) ? openedAtMs + graceMs : null;

  return { windowOpen: true, windowOpenConfirmed, windowOpenPending: !windowOpenConfirmed, windowGraceValidUntilMs };
}

// ---- Factory ----

interface HeatingContext {
  now: Date;
  automationEnabled: boolean;
  currentMode: string | null;
  safety: WindowSafety & { forceMinimum: boolean };
  house: { mode: string | null; affectsHeating: boolean };
  manualMode: HeatingMode | null;
  manualExpiring: boolean;
  occupied: boolean;
  schedule: ResolvedSchedule;
  scheduleTimerKey: string;
  manualTimerKey: string;
  manualSelectEntity: string;
  windowGraceTimerKey: string;
}

export function makeHeatingAutomation(config: HeatingRoomConfig) {
  const { location, scheduleConfig, independent = false } = config;

  const windowEntity = `binary_sensor.${location}_external_openings`;
  const scheduleTimerKey = `${location}:${SCHEDULE_TIMER_SUFFIX}`;
  const manualTimerKey = `${location}:${MANUAL_TIMER_SUFFIX}`;
  const windowGraceTimerKey = `${location}:${WINDOW_GRACE_TIMER_SUFFIX}`;
  const manualSelectEntity = `input_select.${location}_heating_manual_mode`;
  const activeHeatingTopic = `${location}/heating/active`;
  const activeHeatingEntity = `sensor.${location}_active_heating`;
  const sourceTopic = `${location}/heating/source`;
  const sourceEntity = `sensor.${location}_heating_source`;

  return defineAutomation<HeatingContext>({
    id: `${location}:heating`,
    location,
    subsystem: 'heating',

    triggers: [
      { type: 'state_changed', entity: `input_boolean.${location}_automation_heating_enabled` as keyof HAEntities },
      { type: 'state_changed', entity: 'sensor.house_active_mode' },
      { type: 'state_changed', entity: 'input_boolean.house_heating_enabled' },
      { type: 'state_changed', entity: windowEntity as keyof HAEntities },
      { type: 'state_changed', entity: 'input_boolean.wfh_adam' },
      { type: 'state_changed', entity: 'input_boolean.wfh_sarah' },
      { type: 'state_changed', entity: manualSelectEntity as keyof HAEntities },
      { type: 'state_changed', entity: `sensor.${location}_occupied` as keyof HAEntities },
      { type: 'timer_expired', timerKey: scheduleTimerKey },
      { type: 'timer_expired', timerKey: manualTimerKey },
      { type: 'timer_expired', timerKey: windowGraceTimerKey },
      { type: 'on_start' },
    ],

    context: (state, _ha, event) => {
      const now = new Date();
      const weekday = now.getDay() !== 0 && now.getDay() !== 6;
      const manualExpiring = event.type === 'timer_expired' && event.timerKey === manualTimerKey;

      const automationEnabledState = state(`input_boolean.${location}_automation_heating_enabled` as keyof HAEntities)?.state;
      if (!automationEnabledState || automationEnabledState === 'unavailable' || automationEnabledState === 'unknown') {
        return abort(`automation_enabled_unavailable:${automationEnabledState}`);
      }
      const automationEnabled = automationEnabledState === 'on';

      const currentMode = state(`sensor.${location}_active_heating` as keyof HAEntities)?.state ?? null;

      const windowState = state(windowEntity as keyof HAEntities);
      const graceHelperState = state(WINDOW_GRACE_HELPER as keyof HAEntities)?.state;
      const windowSafety = resolveWindowSafety(windowState, graceHelperState, now);

      const heatingSystemEnabled = state('input_boolean.house_heating_enabled')?.state === 'on';
      const forceMinimum = !independent && !heatingSystemEnabled;

      const houseMode = state('sensor.house_active_mode')?.state ?? null;
      const affectsHeating = !independent && houseMode !== null && (HOUSE_MODES_AFFECTING_HEATING as readonly string[]).includes(houseMode);

      const wfhAdam = state('input_boolean.wfh_adam')?.state === 'on';
      const wfhSarah = state('input_boolean.wfh_sarah')?.state === 'on';

      const manualSelectState = state(manualSelectEntity as keyof HAEntities)?.state ?? 'auto';
      const manualMode = (!manualExpiring && manualSelectState !== 'auto' && VALID_HEATING_MODES.has(manualSelectState))
        ? (manualSelectState as HeatingMode)
        : null;

      const occupied = state(`sensor.${location}_occupied` as keyof HAEntities)?.state === 'occupied';
      const schedule = resolveSchedule(scheduleConfig, weekday, wfhAdam, wfhSarah, now);

      return {
        now,
        automationEnabled,
        currentMode,
        safety: { ...windowSafety, forceMinimum },
        house: { mode: houseMode, affectsHeating },
        manualMode,
        manualExpiring,
        occupied,
        schedule,
        scheduleTimerKey,
        manualTimerKey,
        manualSelectEntity,
        windowGraceTimerKey,
        wfhAdam,
        wfhSarah,
        weekday,
      };
    },

    reduce: (ctx) => {
      const { automationEnabled, currentMode, safety, house, manualMode, manualExpiring, occupied, schedule, scheduleTimerKey, manualTimerKey, manualSelectEntity, windowGraceTimerKey, now } = ctx;
      const actions: Action[] = [];
      const nowMs = now.getTime();

      let targetMode: HeatingMode | null = null;
      let source: HeatingSource = 'none';
      let decision = 'no_action';
      let reason = 'uninitialised';

      // Stage 1 — automation disabled
      if (!automationEnabled) {
        return { decision: 'blocked', reason: 'automation_disabled', actions: [] };
      }

      // Stage 2 — safety (windowOpen takes precedence over forceMinimum)
      if (safety.windowOpenConfirmed) {
        targetMode = 'minimum';
        source = 'safety';
        decision = 'set_mode';
        reason = 'safety_window_open';
      } else if (safety.forceMinimum) {
        targetMode = 'minimum';
        source = 'safety';
        decision = 'set_mode';
        reason = 'safety_heating_disabled';
      }

      // A window that has only just opened doesn't force minimum yet, but still needs a
      // timer so the safety override fires the moment it's been open long enough — waiting
      // for some other trigger to happen to re-check would let it stay open indefinitely.
      if (safety.windowOpenPending) {
        actions.push(...planTimer(windowGraceTimerKey, safety.windowGraceValidUntilMs, nowMs));
      } else {
        actions.push({ type: 'timer.cancel', timerKey: windowGraceTimerKey });
      }

      // Stage 3 — house mode (affectsHeating guarantees mode is non-null and in HOUSE_MODE_MAP)
      if (!targetMode && house.affectsHeating) {
        targetMode = HOUSE_MODE_MAP[house.mode as HouseMode];
        source = 'house_mode';
        decision = 'set_mode';
        reason = `house_mode_${house.mode}`;
      }

      // Stage 4 — manual override
      if (!targetMode && manualMode) {
        targetMode = manualMode;
        source = 'manual';
        decision = 'set_mode';
        reason = 'manual_override';
        actions.push(...planTimer(manualTimerKey, schedule.validUntilMs, nowMs));
      } else {
        actions.push({ type: 'timer.cancel', timerKey: manualTimerKey });
        if (manualExpiring) {
          actions.push(HomeAssistant.input_select.select_option({ entity_id: manualSelectEntity }, { option: 'auto' }));
        }
      }

      // Stage 5 — schedule (with optional occupancy upgrade)
      if (!targetMode && schedule.requestedMode) {
        const occupiedMode = schedule.block?.occupiedMode;
        targetMode = (occupied && occupiedMode) ? occupiedMode : schedule.requestedMode;
        source = 'schedule';
        decision = 'set_mode';
        reason = (occupied && occupiedMode) ? 'schedule_occupied' : 'schedule';
      }

      // Stage 6 — no schedule match
      if (!targetMode) {
        return { decision: 'no_action', reason: 'no_schedule_match', actions };
      }

      // Stage 7 — no-op detection
      if (targetMode === currentMode) {
        actions.push(...planTimer(scheduleTimerKey, schedule.validUntilMs, nowMs));
        return { decision: 'maintain', reason: 'no_change', actions };
      }

      // Stage 8 — emit mode + source
      actions.push({ type: 'mqtt.publish', topic: activeHeatingTopic, payload: targetMode, retain: true, impliesEntity: activeHeatingEntity });
      actions.push({ type: 'mqtt.publish', topic: sourceTopic, payload: source, retain: true, impliesEntity: sourceEntity });
      actions.push(...planTimer(scheduleTimerKey, schedule.validUntilMs, nowMs));

      return { decision, reason, actions };
    },
  });
}
