import { defineAutomation, abort } from '@ajclarkson/homerun';

// Loki showed kitchen occupancy consistently firing within seconds of the
// manual exit-sleep button press over the last two weeks, with zero overnight
// false positives (unlike hallway_downstairs, which the cat trips regularly).
// Kitchen motion is therefore a reliable stand-in for "day has started" —
// but only within a plausible morning window; a late arrival home walking
// into the kitchen at night is kitchen motion too, and must not exit sleep
// mode. See house/exit-sleep-button.ts for the manual path this complements
// (which is unrestricted by time, since a button press is always deliberate).
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

    const earliestHour = parseInt(state('input_number.house_automation_exit_sleep_earliest_hour')?.state ?? '', 10);
    const latestHour = parseInt(state('input_number.house_automation_exit_sleep_latest_hour')?.state ?? '', 10);
    const required = { earliestHour, latestHour };
    for (const [name, val] of Object.entries(required)) {
      if (!Number.isFinite(val)) return abort(`sensor_unavailable:${name}`);
    }

    const hour = new Date().getHours();
    const withinMorningWindow = hour >= earliestHour && hour < latestHour;

    return { houseMode, withinMorningWindow };
  },

  reduce: (ctx) => {
    if (ctx.houseMode !== 'sleep') {
      return { decision: 'no_action', reason: 'not_in_sleep_mode', actions: [] };
    }
    if (!ctx.withinMorningWindow) {
      return { decision: 'no_action', reason: 'outside_morning_window', actions: [] };
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
