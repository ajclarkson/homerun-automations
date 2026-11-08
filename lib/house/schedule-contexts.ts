// Lives under lib/ because the runtime skips lib/ when scanning for automations; this file is data.
import type { ScheduleContext } from '../heating-controller-factory.js';

/** The house's heating schedule contexts, highest priority first. A room's schedule picks the
 *  first context here that applies and that the room defines blocks for. Defined once so every
 *  room agrees on what "working from home" means; the last entry is the catch-all. */
export const HOUSE_SCHEDULE_CONTEXTS: readonly ScheduleContext[] = [
  { key: 'weekday_wfh_adam', weekday: true, helper: 'input_boolean.wfh_adam' },
  { key: 'weekday_wfh_sarah', weekday: true, helper: 'input_boolean.wfh_sarah' },
  { key: 'weekend', weekday: false },
  { key: 'weekday', weekday: true },
  { key: 'default' },
];
