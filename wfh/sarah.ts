import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'wfh:sarah',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'schedule', cron: '15 7 * * 1-5' },  // Mon-Fri 07:15
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    const isWorkday = state('binary_sensor.workday_sensor')?.state === 'on';
    const sarahHome = state('person.sarah')?.state === 'home';

    if (houseMode === 'away') return abort('house_away');
    if (!isWorkday) return abort('not_workday');

    return {
      sarahHome,
      inputs: { houseMode, isWorkday, sarahHome },
    };
  },

  reduce: (ctx) => {
    const reason = ctx.sarahHome ? 'home_at_inference_time' : 'not_home_at_inference_time';

    return {
      decision: ctx.sarahHome ? 'on' : 'off',
      reason,
      inputs: ctx.inputs,
      actions: [
        {
          type: 'ha.call_service',
          domain: 'input_boolean',
          service: ctx.sarahHome ? 'turn_on' : 'turn_off',
          target: { entity_id: 'input_boolean.wfh_sarah' },
        },
      ],
    };
  },
});
