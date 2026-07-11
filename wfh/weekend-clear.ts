import { defineAutomation, abort } from '@ajclarkson/homerun';

// Fires whenever workday_sensor changes state. Guards on the sensor being
// off — so on Monday morning (on) this aborts cleanly, on Friday evening
// (off) it clears both flags. Uses the workday integration which is
// UK bank holiday-aware, so bank holiday Mondays are handled correctly.
export default defineAutomation({
  id: 'wfh:weekend-clear',
  location: 'house',
  subsystem: 'wfh_inference',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.workday_sensor' },
  ],

  context: (state) => {
    const isWorkday = state('binary_sensor.workday_sensor')?.state === 'on';

    if (isWorkday) return abort('is_workday');

    return { inputs: { isWorkday } };
  },

  reduce: () => ({
    decision: 'off',
    reason: 'non_workday_clear',
    actions: [
      {
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_off',
        target: { entity_id: 'input_boolean.wfh_adam' },
      },
      {
        type: 'ha.call_service',
        domain: 'input_boolean',
        service: 'turn_off',
        target: { entity_id: 'input_boolean.wfh_sarah' },
      },
    ],
  }),
});
