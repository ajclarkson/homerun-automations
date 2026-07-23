import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';

// Adam: Wed–Fri always WFH; Mon–Tue inferred from presence at 08:00
const adamWfh = defineAutomation({
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
      inputs: { houseMode, workday, adamHome, alwaysOn },
    };
  },

  reduce: (ctx) => {
    const { houseMode, workday, adamHome, alwaysOn } = ctx;

    let decision: 'on' | 'off' = 'off';
    let reason = 'uninitialised';

    if (houseMode === 'away')    { decision = 'off'; reason = 'house_away'; }
    else if (workday !== 'on')   { decision = 'off'; reason = 'not_workday'; }
    else if (alwaysOn)           { decision = 'on';  reason = 'always_wfh_wed_fri'; }
    else if (adamHome)           { decision = 'on';  reason = 'home_at_inference_time'; }
    else                         { decision = 'off'; reason = 'not_home_at_inference_time'; }

    return {
      decision,
      reason,
      inputs: ctx.inputs,
      actions: [
        decision === 'on'
          ? HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.wfh_adam' })
          : HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_adam' }),
      ],
    };
  },
});

// Sarah: if home at 07:15 on a workday, inferred as WFH
const sarahWfh = defineAutomation({
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
      inputs: { houseMode, workday, sarahHome },
    };
  },

  reduce: (ctx) => {
    const { houseMode, workday, sarahHome } = ctx;

    let decision: 'on' | 'off' = 'off';
    let reason = 'uninitialised';

    if (houseMode === 'away')    { decision = 'off'; reason = 'house_away'; }
    else if (workday !== 'on')   { decision = 'off'; reason = 'not_workday'; }
    else if (sarahHome)          { decision = 'on';  reason = 'home_at_inference_time'; }
    else                         { decision = 'off'; reason = 'not_home_at_inference_time'; }

    return {
      decision,
      reason,
      inputs: ctx.inputs,
      actions: [
        decision === 'on'
          ? HomeAssistant.input_boolean.turn_on({ entity_id: 'input_boolean.wfh_sarah' })
          : HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_sarah' }),
      ],
    };
  },
});

// Reset: when workday_sensor goes off (weekends + bank holidays), clear both flags
const wfhReset = defineAutomation({
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
      inputs: { workday },
    };
  },

  reduce: (ctx) => {
    if (ctx.workday !== 'off') {
      return { decision: 'no_action', reason: 'not_a_non_workday', inputs: ctx.inputs, actions: [] };
    }

    return {
      decision: 'clear',
      reason: 'non_workday',
      inputs: ctx.inputs,
      actions: [
        HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_adam' }),
        HomeAssistant.input_boolean.turn_off({ entity_id: 'input_boolean.wfh_sarah' }),
      ],
    };
  },
});

export { adamWfh, sarahWfh, wfhReset };
export default [adamWfh, sarahWfh, wfhReset];
