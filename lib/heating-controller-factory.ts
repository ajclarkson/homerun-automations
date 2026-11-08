import { defineAutomation, abort, HomeAssistant, type Action, type DeclaredDecision } from '@ajclarkson/homerun';

// ---- Types ----

export type HeatingMode = 'minimum' | 'baseline_night' | 'baseline_day' | 'comfort';
export type HeatingSource = 'schedule' | 'manual' | 'house_mode' | 'safety' | 'none';

/** One schedule context, in priority order. It applies when every condition it names holds:
 *  `weekday` matches the day type, `helper` is an input_boolean that is on. A context naming
 *  neither always applies, so the last one is the catch-all. The house defines the list once
 *  (heating/schedule-contexts.ts); the factory knows no names. */
export interface ScheduleContext {
  key: string;
  weekday?: boolean;
  helper?: string;
}

export type ScheduleContextKey = string;

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
  /** The house's ordered schedule contexts; every key in `byContext` must be one of them. */
  contexts: readonly ScheduleContext[];
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
  // The cat stays home while we're at work — minimum is for genuinely
  // nobody-cares situations (safety overrides, off-hours schedule blocks),
  // not an empty-but-occupied-by-a-cat house.
  away: 'baseline_night',
  vacation: 'minimum',
};

const SCHEDULE_TIMER_SUFFIX = 'heating:schedule_boundary';
const MANUAL_TIMER_SUFFIX = 'heating:manual_override_expiry';
const WINDOW_GRACE_TIMER_SUFFIX = 'heating:window_open_grace';
const MIDNIGHT_TIMER_SUFFIX = 'heating:midnight_rollover';

export const WINDOW_GRACE_HELPER = 'input_number.global_heating_window_open_grace_minutes';
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

const CONTEXT_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;
const HELPER_ENTITY_PATTERN = /^input_boolean\.[a-z0-9_]+$/;

/** Throws on a context list that could resolve nothing or resolve wrongly. Run at load. */
export function assertValidScheduleContexts(contexts: readonly ScheduleContext[]): void {
  if (contexts.length === 0) throw new Error('heating contexts: list is empty');
  const seen = new Set<string>();
  for (const c of contexts) {
    if (typeof c.key !== 'string' || !CONTEXT_KEY_PATTERN.test(c.key)) {
      throw new Error(`heating contexts: key '${String(c.key)}' is not a lowercase identifier`);
    }
    if (seen.has(c.key)) throw new Error(`heating contexts: duplicate key '${c.key}'`);
    seen.add(c.key);
    if (c.weekday !== undefined && typeof c.weekday !== 'boolean') {
      throw new Error(`heating contexts: '${c.key}' weekday must be a boolean`);
    }
    if (c.helper !== undefined && !HELPER_ENTITY_PATTERN.test(c.helper)) {
      throw new Error(`heating contexts: '${c.key}' helper '${c.helper}' is not an input_boolean entity id`);
    }
  }
  const last = contexts[contexts.length - 1]!;
  if (last.weekday !== undefined || last.helper !== undefined) {
    throw new Error(`heating contexts: last context '${last.key}' must be a catch-all with no conditions`);
  }
}

/** Helpers the contexts read, each once, in list order. */
function contextHelpers(contexts: readonly ScheduleContext[]): string[] {
  const helpers: string[] = [];
  for (const c of contexts) if (c.helper !== undefined && !helpers.includes(c.helper)) helpers.push(c.helper);
  return helpers;
}

/** Keys of the contexts that apply right now, highest priority first. */
export function buildContextKeys(
  contexts: readonly ScheduleContext[],
  weekday: boolean,
  helpersOn: Readonly<Record<string, boolean>>,
): string[] {
  return contexts
    .filter(c => (c.weekday === undefined || c.weekday === weekday) && (c.helper === undefined || helpersOn[c.helper] === true))
    .map(c => c.key);
}

interface ResolvedSchedule {
  /** The chosen context's configured blocks, in order; null when the room defines no context. */
  blocks: HeatingBlock[] | null;
  requestedMode: HeatingMode | null;
  validUntilMs: number | null;
  block: HeatingBlock | null;
  contextKey: ScheduleContextKey | null;
}

function resolveSchedule(
  scheduleConfig: HeatingRoomConfig['scheduleConfig'],
  contexts: readonly ScheduleContext[],
  weekday: boolean,
  helpersOn: Readonly<Record<string, boolean>>,
  now: Date,
): ResolvedSchedule {
  const { byContext } = scheduleConfig;
  const keys = buildContextKeys(contexts, weekday, helpersOn);

  let blocks: HeatingBlock[] | null = null;
  let contextKey: ScheduleContextKey | null = null;
  for (const key of keys) {
    if (Array.isArray(byContext[key])) {
      blocks = byContext[key]!;
      contextKey = key;
      break;
    }
  }

  if (!blocks) return { blocks: null, requestedMode: null, validUntilMs: null, block: null, contextKey: null };

  const block = resolveActiveBlock(blocks, now);
  if (!block) return { blocks, requestedMode: null, validUntilMs: null, block: null, contextKey };

  return {
    blocks,
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

// ---- Day plan (published for the Pulse day-plan card) ----

export interface HeatingPlanBlock {
  start: string; // local 'HH:MM'
  end: string;   // local 'HH:MM'; '24:00' allowed as end of day
  mode: HeatingMode;
  occupied_mode?: HeatingMode;
}

export interface HeatingPlan {
  date: string; // local 'YYYY-MM-DD' the blocks are for
  context: ScheduleContextKey;
  blocks: HeatingPlanBlock[];
  active: { mode: HeatingMode; source: HeatingSource; until: string | null };
  override: { mode: HeatingMode; until: string | null } | null;
}

const HHMM_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

function isPlanTime(value: unknown, allowEndOfDay: boolean): boolean {
  return typeof value === 'string' && (HHMM_PATTERN.test(value) || (allowEndOfDay && value === '24:00'));
}

/** Throws on anything a consumer could not draw. A partial plan is worse than none, so the
 *  publisher never sends one. Run on configured blocks at load and on the built payload. */
export function assertValidPlanBlocks(blocks: readonly HeatingBlock[], where: string): void {
  if (blocks.length === 0) throw new Error(`heating plan: ${where} has no blocks`);
  for (const b of blocks) {
    if (!isPlanTime(b.start, false)) throw new Error(`heating plan: ${where} block start '${b.start}' is not HH:MM`);
    if (!isPlanTime(b.end, true)) throw new Error(`heating plan: ${where} block end '${b.end}' is not HH:MM`);
    if (!VALID_HEATING_MODES.has(b.mode)) throw new Error(`heating plan: ${where} block mode '${b.mode}' is not a heating mode`);
    if (b.occupiedMode !== undefined && !VALID_HEATING_MODES.has(b.occupiedMode)) {
      throw new Error(`heating plan: ${where} block occupiedMode '${b.occupiedMode}' is not a heating mode`);
    }
  }
}

function assertValidPlan(plan: HeatingPlan): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date)) throw new Error(`heating plan: date '${plan.date}' is not YYYY-MM-DD`);
  assertValidPlanBlocks(plan.blocks.map(b => ({ start: b.start, end: b.end, mode: b.mode, occupiedMode: b.occupied_mode })), `context '${plan.context}'`);
  if (!VALID_HEATING_MODES.has(plan.active.mode)) throw new Error(`heating plan: active mode '${plan.active.mode}' is not a heating mode`);
}

function localDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// ISO 8601 UTC without milliseconds, as the contract shows.
function isoUtc(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** Null when the room defines no schedule context: there is nothing to draw. */
export function buildHeatingPlan(
  schedule: ResolvedSchedule,
  now: Date,
  active: { mode: HeatingMode; source: HeatingSource },
): HeatingPlan | null {
  if (!schedule.blocks || !schedule.contextKey) return null;
  const manual = active.source === 'manual';
  // Only schedule and manual choices end at the block boundary; safety and house mode hold until
  // their own trigger changes, so they have no end time.
  const until = (active.source === 'schedule' || manual) ? isoUtc(schedule.validUntilMs) : null;
  const plan: HeatingPlan = {
    date: localDate(now),
    context: schedule.contextKey,
    blocks: schedule.blocks.map(b => ({
      start: b.start,
      end: b.end,
      mode: b.mode,
      ...(b.occupiedMode ? { occupied_mode: b.occupiedMode } : {}),
    })),
    active: { mode: active.mode, source: active.source, until },
    override: manual ? { mode: active.mode, until } : null,
  };
  assertValidPlan(plan);
  return plan;
}

/** Only the contract's fields, in contract order, so HA's extra attributes (friendly_name) and
 *  key order never make an unchanged plan look changed. */
function planFingerprint(plan: Partial<HeatingPlan> | null | undefined): string | null {
  if (!plan || typeof plan !== 'object') return null;
  const { date, context, blocks, active, override } = plan;
  if (date === undefined) return null;
  return JSON.stringify({ date, context, blocks, active, override: override ?? null });
}

function planMidnightMs(now: Date): number {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0); // local next midnight; DST-safe
  return midnight.getTime();
}

// ---- Window-open safety debounce ----

interface WindowSafety {
  windowOpen: boolean;
  windowOpenConfirmed: boolean;
  windowOpenPending: boolean;
  windowGraceValidUntilMs: number | null;
}

/** Grace period in ms from the helper's state, clamped to its allowed range. */
export function resolveGraceMs(graceHelperState: string | undefined): number {
  const graceMinutesRaw = parseFloat(graceHelperState ?? '');
  const graceMinutes = Number.isFinite(graceMinutesRaw)
    ? Math.min(Math.max(graceMinutesRaw, MIN_WINDOW_GRACE_MINUTES), MAX_WINDOW_GRACE_MINUTES)
    : MIN_WINDOW_GRACE_MINUTES; // helper unavailable — fail toward the stricter immediate-safety behaviour
  return graceMinutes * 60_000;
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

  const graceMs = resolveGraceMs(graceHelperState);

  const openedAtMs = windowState?.last_changed ? new Date(windowState.last_changed).getTime() : NaN;
  // Unknown open-since time is treated as already past grace — never delay safety on missing data.
  const elapsedMs = Number.isFinite(openedAtMs) ? now.getTime() - openedAtMs : Infinity;

  const windowOpenConfirmed = elapsedMs >= graceMs;
  const windowGraceValidUntilMs = !windowOpenConfirmed && Number.isFinite(openedAtMs) ? openedAtMs + graceMs : null;

  return { windowOpen: true, windowOpenConfirmed, windowOpenPending: !windowOpenConfirmed, windowGraceValidUntilMs };
}

// ---- Reasons ----

// Every reason the reducer can return. A mode change is `acted` and carries the new mode; the
// house-mode reason is one name per mode so no value is embedded in a reason. A disabled room
// reports on every trigger it would have handled, so it is `ignored` rather than history noise.
export const HEATING_REASONS = {
  safety_window_open: { outcome: 'acted', facts: ['mode'] },
  safety_heating_disabled: { outcome: 'acted', facts: ['mode'] },
  house_mode_sleep: { outcome: 'acted', facts: ['mode', 'cause'] },
  house_mode_away: { outcome: 'acted', facts: ['mode', 'cause'] },
  house_mode_vacation: { outcome: 'acted', facts: ['mode', 'cause'] },
  manual_override: { outcome: 'acted', facts: ['mode', 'cause'] },
  schedule_occupied: { outcome: 'acted', facts: ['mode', 'cause'] },
  schedule: { outcome: 'acted', facts: ['mode', 'cause'] },
  automation_disabled: { outcome: 'ignored' },
  no_schedule_match: { outcome: 'ignored' },
  no_change: { outcome: 'ignored' },
} as const;

type HeatingDecision = DeclaredDecision<typeof HEATING_REASONS>;
type SetModeReason = Exclude<keyof typeof HEATING_REASONS, 'automation_disabled' | 'no_schedule_match' | 'no_change'>;

const HOUSE_MODE_REASON: Record<HouseMode, SetModeReason> = {
  sleep: 'house_mode_sleep',
  away: 'house_mode_away',
  vacation: 'house_mode_vacation',
};

// ---- Cause ----

// Why the reducer ran, in words a person recognises. The reason says what was decided; the cause
// says what set it off (the 6pm boundary, the window closing, someone arriving).
// `manual_set` is a person picking a mode; the rest mirror the triggers below. `other` exists only
// as a runtime fallback: a trigger added to the list without a cause must not stop heating from
// deciding, but the test that walks every declared trigger fails until it is mapped.
export type HeatingCause =
  | 'boundary' | 'window_closed' | 'house_mode' | 'manual_ended' | 'manual_set'
  | 'occupancy' | 'heating_on' | 'wfh' | 'startup' | 'other';

type CauseEvent =
  | { type: 'state_changed'; entity_id: string; new_state: { state: string } }
  | { type: 'timer_expired'; timerKey: string }
  | { type: string };

export function causeOf(event: CauseEvent, location: string, contexts: readonly ScheduleContext[]): HeatingCause {
  if (event.type === 'on_start') return 'startup';
  if (event.type === 'timer_expired') {
    const { timerKey } = event as { timerKey: string };
    // Midnight is a day boundary: the plan's date and context roll over.
    if (timerKey === `${location}:${SCHEDULE_TIMER_SUFFIX}` || timerKey === `${location}:${MIDNIGHT_TIMER_SUFFIX}`) return 'boundary';
    if (timerKey === `${location}:${MANUAL_TIMER_SUFFIX}`) return 'manual_ended';
    // The grace timer ends a window episode; the closing itself is a window state change.
    if (timerKey === `${location}:${WINDOW_GRACE_TIMER_SUFFIX}`) return 'window_closed';
    return 'other';
  }
  if (event.type === 'state_changed') {
    const { entity_id, new_state } = event as { entity_id: string; new_state: { state: string } };
    if (entity_id === 'sensor.house_active_mode') return 'house_mode';
    if (entity_id === 'input_boolean.house_heating_enabled') return 'heating_on';
    if (entity_id === `input_boolean.${location}_automation_heating_enabled`) return 'heating_on';
    if (entity_id === `binary_sensor.${location}_external_openings`) return 'window_closed';
    if (contextHelpers(contexts).includes(entity_id)) return 'wfh';
    if (entity_id === `binary_sensor.${location}_occupied`) return 'occupancy';
    if (entity_id === `input_select.${location}_heating_manual_mode`) return new_state.state === 'auto' ? 'manual_ended' : 'manual_set';
  }
  return 'other';
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
  midnightTimerKey: string;
  /** Fingerprint of the plan HA last received on the plan topic; null if none yet. */
  publishedPlan: string | null;
  cause: HeatingCause;
  weekday: boolean;
  /** Each schedule-context helper and whether it is on; published so a snapshot shows why a context won. */
  helpersOn: Record<string, boolean>;
}

// ---- Reducer stages ----

interface Choice {
  mode: HeatingMode;
  source: HeatingSource;
  reason: SetModeReason;
}

/** Stage 2: safety. A confirmed open window takes precedence over the house heating switch. */
function safetyChoice(safety: HeatingContext['safety']): Choice | null {
  if (safety.windowOpenConfirmed) return { mode: 'minimum', source: 'safety', reason: 'safety_window_open' };
  if (safety.forceMinimum) return { mode: 'minimum', source: 'safety', reason: 'safety_heating_disabled' };
  return null;
}

// A window that has only just opened doesn't force minimum yet, but still needs a timer so the
// safety override fires the moment it's been open long enough: waiting for some other trigger
// to re-check would let it stay open indefinitely.
function windowGraceActions(ctx: HeatingContext, nowMs: number): Action[] {
  if (ctx.safety.windowOpenPending) return planTimer(ctx.windowGraceTimerKey, ctx.safety.windowGraceValidUntilMs, nowMs);
  return [{ type: 'timer.cancel', timerKey: ctx.windowGraceTimerKey }];
}

/** Stage 3: house mode. affectsHeating guarantees the mode is non-null and in HOUSE_MODE_MAP. */
function houseModeChoice(house: HeatingContext['house']): Choice | null {
  if (!house.affectsHeating) return null;
  const mode = house.mode as HouseMode;
  return { mode: HOUSE_MODE_MAP[mode], source: 'house_mode', reason: HOUSE_MODE_REASON[mode] };
}

/** Stage 4: manual override. Only reached with no earlier choice; otherwise the timer is cancelled. */
function manualStage(ctx: HeatingContext, earlier: Choice | null, nowMs: number): { choice: Choice | null; actions: Action[] } {
  if (!earlier && ctx.manualMode) {
    return {
      choice: { mode: ctx.manualMode, source: 'manual', reason: 'manual_override' },
      actions: planTimer(ctx.manualTimerKey, ctx.schedule.validUntilMs, nowMs),
    };
  }
  const actions: Action[] = [{ type: 'timer.cancel', timerKey: ctx.manualTimerKey }];
  if (ctx.manualExpiring) {
    actions.push(HomeAssistant.input_select.select_option({ entity_id: ctx.manualSelectEntity }, { option: 'auto' }));
  }
  return { choice: null, actions };
}

/** Stage 5: schedule, with the optional occupancy upgrade. */
function scheduleChoice(ctx: HeatingContext): Choice | null {
  const { schedule, occupied } = ctx;
  if (!schedule.requestedMode) return null;
  const occupiedMode = schedule.block?.occupiedMode;
  const upgrade = occupied && occupiedMode;
  return upgrade
    ? { mode: occupiedMode, source: 'schedule', reason: 'schedule_occupied' }
    : { mode: schedule.requestedMode, source: 'schedule', reason: 'schedule' };
}

/** Publish the day plan whenever it differs from what HA holds, whether or not the mode moved. */
function planActions(ctx: HeatingContext, choice: Choice, planTopic: string, planEntity: string): Action[] {
  const plan = buildHeatingPlan(ctx.schedule, ctx.now, { mode: choice.mode, source: choice.source });
  if (!plan || planFingerprint(plan) === ctx.publishedPlan) return [];
  return [{ type: 'mqtt.publish', topic: planTopic, payload: JSON.stringify(plan), retain: true, impliesEntity: planEntity }];
}

interface HeatingTopics {
  activeHeatingTopic: string;
  activeHeatingEntity: string;
  sourceTopic: string;
  sourceEntity: string;
  planTopic: string;
  planEntity: string;
}

/** Emit the new mode and source, then say why. Safety overrides are their own explanation;
 *  every other reason also carries its cause. */
function setModeDecision(ctx: HeatingContext, choice: Choice, topics: HeatingTopics, actions: Action[], nowMs: number): HeatingDecision {
  actions.push({ type: 'mqtt.publish', topic: topics.activeHeatingTopic, payload: choice.mode, retain: true, impliesEntity: topics.activeHeatingEntity });
  actions.push({ type: 'mqtt.publish', topic: topics.sourceTopic, payload: choice.source, retain: true, impliesEntity: topics.sourceEntity });
  actions.push(...planTimer(ctx.scheduleTimerKey, ctx.schedule.validUntilMs, nowMs));
  if (choice.reason === 'safety_window_open' || choice.reason === 'safety_heating_disabled') {
    return { decision: 'set_mode', reason: choice.reason, facts: { mode: choice.mode }, actions };
  }
  return { decision: 'set_mode', reason: choice.reason, facts: { mode: choice.mode, cause: ctx.cause }, actions };
}

function reduceHeating(ctx: HeatingContext, topics: HeatingTopics): HeatingDecision {
  // Stage 1: automation disabled
  if (!ctx.automationEnabled) {
    return { decision: 'blocked', reason: 'automation_disabled', actions: [] };
  }
  const nowMs = ctx.now.getTime();
  // The plan's date and context change at local midnight with no other trigger.
  const actions: Action[] = [...planTimer(ctx.midnightTimerKey, planMidnightMs(ctx.now), nowMs)];

  const safety = safetyChoice(ctx.safety);
  actions.push(...windowGraceActions(ctx, nowMs));
  const earlier = safety ?? houseModeChoice(ctx.house);
  const manual = manualStage(ctx, earlier, nowMs);
  actions.push(...manual.actions);
  const choice = earlier ?? manual.choice ?? scheduleChoice(ctx);

  // Stage 6: no schedule match
  if (!choice) return { decision: 'no_action', reason: 'no_schedule_match', actions };

  actions.push(...planActions(ctx, choice, topics.planTopic, topics.planEntity));

  // Stage 7: no-op detection
  if (choice.mode === ctx.currentMode) {
    actions.push(...planTimer(ctx.scheduleTimerKey, ctx.schedule.validUntilMs, nowMs));
    return { decision: 'maintain', reason: 'no_change', actions };
  }
  return setModeDecision(ctx, choice, topics, actions, nowMs);
}

export function makeHeatingAutomation(config: HeatingRoomConfig) {
  const { location, scheduleConfig, contexts, independent = false } = config;

  assertValidScheduleContexts(contexts);
  const helpers = contextHelpers(contexts);

  // Fail at load, not at 3am: a malformed block would otherwise be skipped silently by schedule
  // resolution and never reach the plan.
  for (const [key, blocks] of Object.entries(scheduleConfig.byContext)) {
    if (!contexts.some(c => c.key === key)) throw new Error(`heating contexts: ${location} defines unknown context '${key}'`);
    assertValidPlanBlocks(blocks ?? [], `${location} context '${key}'`);
  }

  const windowEntity = `binary_sensor.${location}_external_openings`;
  const scheduleTimerKey = `${location}:${SCHEDULE_TIMER_SUFFIX}`;
  const manualTimerKey = `${location}:${MANUAL_TIMER_SUFFIX}`;
  const windowGraceTimerKey = `${location}:${WINDOW_GRACE_TIMER_SUFFIX}`;
  const manualSelectEntity = `input_select.${location}_heating_manual_mode`;
  const activeHeatingTopic = `${location}/heating/active`;
  const activeHeatingEntity = `sensor.${location}_active_heating`;
  const sourceTopic = `${location}/heating/source`;
  const sourceEntity = `sensor.${location}_heating_source`;
  const planTopic = `${location}/heating/plan`;
  const planEntity = `sensor.${location}_heating_plan`;
  const midnightTimerKey = `${location}:${MIDNIGHT_TIMER_SUFFIX}`;
  const topics: HeatingTopics = { activeHeatingTopic, activeHeatingEntity, sourceTopic, sourceEntity, planTopic, planEntity };

  return defineAutomation<HeatingContext, typeof HEATING_REASONS>({
    reasons: HEATING_REASONS,
    id: `${location}:heating`,
    location,
    subsystem: 'heating',

    triggers: [
      { type: 'state_changed', entity: `input_boolean.${location}_automation_heating_enabled` as keyof HAEntities },
      { type: 'state_changed', entity: 'sensor.house_active_mode' },
      { type: 'state_changed', entity: 'input_boolean.house_heating_enabled' },
      { type: 'state_changed', entity: windowEntity as keyof HAEntities },
      ...helpers.map(entity => ({ type: 'state_changed' as const, entity: entity as keyof HAEntities })),
      { type: 'state_changed', entity: manualSelectEntity as keyof HAEntities },
      { type: 'state_changed', entity: `binary_sensor.${location}_occupied` as keyof HAEntities },
      { type: 'timer_expired', timerKey: scheduleTimerKey },
      { type: 'timer_expired', timerKey: manualTimerKey },
      { type: 'timer_expired', timerKey: windowGraceTimerKey },
      { type: 'timer_expired', timerKey: midnightTimerKey },
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

      const helpersOn: Record<string, boolean> = {};
      for (const helper of helpers) helpersOn[helper] = state(helper as keyof HAEntities)?.state === 'on';

      const manualSelectState = state(manualSelectEntity as keyof HAEntities)?.state ?? 'auto';
      const manualMode = (!manualExpiring && manualSelectState !== 'auto' && VALID_HEATING_MODES.has(manualSelectState))
        ? (manualSelectState as HeatingMode)
        : null;

      const occupied = state(`binary_sensor.${location}_occupied` as keyof HAEntities)?.state === 'on';
      const schedule = resolveSchedule(scheduleConfig, contexts, weekday, helpersOn, now);

      // The plan sensor's attributes are what HA holds of the last publish: comparing with them
      // survives restarts and hot reloads, unlike a variable kept in this module.
      const publishedPlan = planFingerprint(state(planEntity as keyof HAEntities)?.attributes as Partial<HeatingPlan> | undefined);

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
        midnightTimerKey,
        publishedPlan,
        cause: causeOf(event, location, contexts),
        helpersOn,
        weekday,
      };
    },

    reduce: ctx => reduceHeating(ctx, topics),
  });
}
