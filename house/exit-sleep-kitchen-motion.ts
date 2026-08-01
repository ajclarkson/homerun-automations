import { defineAutomation, abort } from '@ajclarkson/homerun';

// Loki showed kitchen occupancy consistently firing within seconds of the
// manual exit-sleep button press over the last two weeks, with zero overnight
// false positives (unlike hallway_downstairs, which the cat trips regularly).
// Kitchen motion is therefore a reliable stand-in for "day has started" —
// see house/exit-sleep-button.ts for the manual path this complements.
export default defineAutomation({
  id: 'house:exit_sleep_kitchen_motion',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.kitchen_occupied', to: 'on' },
  ],

  context: (state) => {
    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    return { houseMode };
  },

  reduce: (ctx) => {
    if (ctx.houseMode !== 'sleep') {
      return { decision: 'no_action', reason: 'not_in_sleep_mode', actions: [] };
    }

    return {
      decision: 'exit_sleep',
      reason: 'kitchen_motion_detected',
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
      ],
    };
  },
});
