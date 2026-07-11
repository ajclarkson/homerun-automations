import { defineAutomation, abort } from '@ajclarkson/homerun';

const MONITOR_ON_THRESHOLD_W = 5;

export default defineAutomation({
  id: 'home_office:monitor-hold-sync',
  location: 'home_office',
  subsystem: 'hold-sync',

  triggers: [
    { type: 'state_changed', entity: 'sensor.home_office_plug_monitor_power' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const powerStr = state('sensor.home_office_plug_monitor_power')?.state;
    const power = parseFloat(powerStr ?? '');

    if (!Number.isFinite(power)) {
      return abort(`power_unavailable:${powerStr}`);
    }

    return {
      monitorOn: power > MONITOR_ON_THRESHOLD_W,
      inputs: { power },
    };
  },

  reduce: (ctx) => ({
    decision: ctx.monitorOn ? 'monitor_on' : 'monitor_off',
    reason: `power_${ctx.monitorOn ? 'above' : 'below'}_threshold`,
    inputs: ctx.inputs,
    actions: [
      {
        type: 'mqtt.publish',
        topic: 'home_office/monitor/state',
        payload: ctx.monitorOn ? 'ON' : 'OFF',
        retain: true,
      },
    ],
  }),
});
