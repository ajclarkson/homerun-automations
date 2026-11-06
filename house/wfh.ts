import { defineAutomation, abort, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';

// Inferring a work-from-home day is `acted`. Clearing the flag is mostly a no-change write after a
// weekend or a day out, so the `off` reasons are `ignored`.
export const WFH_ADAM_REASONS = {
  always_wfh_wed_fri: { outcome: 'acted', facts: ['person'] },
  home_at_inference_time: { outcome: 'acted', facts: ['person', 'time'] },
  house_away: { outcome: 'ignored' },
  not_workday: { outcome: 'ignored' },
  not_home_at_inference_time: { outcome: 'ignored' },
} as const;

export const WFH_SARAH_REASONS = {
  home_at_inference_time: { outcome: 'acted', facts: ['person', 'time'] },
  house_away: { outcome: 'ignored' },
  not_workday: { outcome: 'ignored' },
  not_home_at_inference_time: { outcome: 'ignored' },
} as const;

export const WFH_RESET_REASONS = {
  non_workday: { outcome: 'ignored' },
  not_a_non_workday: { outcome: 'ignored' },
} as const;

// The wall-clock time each person is checked, kept beside the cron below so a time fact cannot
// drift from when the check actually runs.
const ADAM_INFERENCE_TIME = '08:00';
const SARAH_INFERENCE_TIME = '07:15';

type WfhAdamDecision = DeclaredDecision<typeof WFH_ADAM_REASONS>;
type WfhSarahDecision = DeclaredDecision<typeof WFH_SARAH_REASONS>;

// Adam: Wed–Fri always WFH; Mon–Tue inferred from presence at 08:00
const adamWfh = defineAutomation({
  reasons: WFH_ADAM_REASONS,
  id: 'house:wfh_adam',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'schedule', cron: '0 6 * * 3-5' },
    { type: 'schedule', cron: '0 8 * * 1-2' },
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    const workday = state('binary_sensor.workday_sensor')?.state;
    const adamHome = state('person.adam')?.state === 'home';
    const day = new Date().getDay();
    const alwaysOn = day >= 3 && day <= 5;

    if (!houseMode) return abort('house_mode_unavailable');

    return {
      houseMode,
      workday,
      adamHome,
      alwaysOn,
    };
  },

  reduce: (ctx): WfhAdamDecision => {
    const { houseMode, workday, adamHome, alwaysOn } = ctx;

    const turnOff = (reason: 'house_away' | 'not_workday' | 'not_home_at_inference_time'): WfhAdamDecision =>
      ({ decision: 'off', reason, actions: [HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_adam' })] });
    const turnOn = HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.wfh_adam' });

    if (houseMode === 'away')  return turnOff('house_away');
    if (workday !== 'on')      return turnOff('not_workday');
    if (alwaysOn)              return { decision: 'on', reason: 'always_wfh_wed_fri', facts: { person: 'adam' }, actions: [turnOn] };
    if (adamHome)              return { decision: 'on', reason: 'home_at_inference_time', facts: { person: 'adam', time: ADAM_INFERENCE_TIME }, actions: [turnOn] };
    return turnOff('not_home_at_inference_time');
  },
});

// Sarah: if home at 07:15 on a workday, inferred as WFH
const sarahWfh = defineAutomation({
  reasons: WFH_SARAH_REASONS,
  id: 'house:wfh_sarah',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'schedule', cron: '15 7 * * 1-5' },
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    const workday = state('binary_sensor.workday_sensor')?.state;
    const sarahHome = state('person.sarah')?.state === 'home';

    if (!houseMode) return abort('house_mode_unavailable');

    return {
      houseMode,
      workday,
      sarahHome,
    };
  },

  reduce: (ctx): WfhSarahDecision => {
    const { houseMode, workday, sarahHome } = ctx;

    const turnOff = (reason: 'house_away' | 'not_workday' | 'not_home_at_inference_time'): WfhSarahDecision =>
      ({ decision: 'off', reason, actions: [HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_sarah' })] });

    if (houseMode === 'away')  return turnOff('house_away');
    if (workday !== 'on')      return turnOff('not_workday');
    if (sarahHome) {
      return {
        decision: 'on',
        reason: 'home_at_inference_time',
        facts: { person: 'sarah', time: SARAH_INFERENCE_TIME },
        actions: [HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.wfh_sarah' })],
      };
    }
    return turnOff('not_home_at_inference_time');
  },
});

// Reset: when workday_sensor goes off (weekends + bank holidays), clear both flags
const wfhReset = defineAutomation({
  reasons: WFH_RESET_REASONS,
  id: 'house:wfh_reset',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.workday_sensor' },
  ],

  context: (state) => {
    const workday = state('binary_sensor.workday_sensor')?.state;

    return {
      workday,
    };
  },

  reduce: (ctx) => {
    if (ctx.workday !== 'off') {
      return { decision: 'no_action', reason: 'not_a_non_workday', actions: [] };
    }

    return {
      decision: 'clear',
      reason: 'non_workday',
      actions: [
        HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_adam' }),
        HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_sarah' }),
      ],
    };
  },
});

export { adamWfh, sarahWfh, wfhReset };
export default [adamWfh, sarahWfh, wfhReset];
