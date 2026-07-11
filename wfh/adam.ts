import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'wfh:adam',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'schedule', cron: '0 6 * * 3-5' },  // Wed-Fri 06:00 — always WFH
    { type: 'schedule', cron: '0 8 * * 1-2' },  // Mon-Tue 08:00 — presence check
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    const isWorkday = state('binary_sensor.workday_sensor')?.state === 'on';
    const adamHome = state('person.adam')?.state === 'home';
    const day = new Date().getDay(); // 0=Sun, 1=Mon ... 5=Fri, 6=Sat
    const alwaysWfh = day >= 3 && day <= 5; // Wed-Fri

    if (houseMode === 'away') return abort('house_away');
    if (!isWorkday) return abort('not_workday');

    return {
      alwaysWfh,
      adamHome,
      inputs: { houseMode, isWorkday, adamHome, day },
    };
  },

  reduce: (ctx) => {
    const wfh = ctx.alwaysWfh || ctx.adamHome;
    const reason = ctx.alwaysWfh
      ? 'always_wfh_wed_fri'
      : ctx.adamHome
        ? 'home_at_inference_time'
        : 'not_home_at_inference_time';

    return {
      decision: wfh ? 'on' : 'off',
      reason,
      inputs: ctx.inputs,
      actions: [
        {
          type: 'ha.call_service',
          domain: 'input_boolean',
          service: wfh ? 'turn_on' : 'turn_off',
          target: { entity_id: 'input_boolean.wfh_adam' },
        },
      ],
    };
  },
});
