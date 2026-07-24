import { defineAutomation, requireState } from '@ajclarkson/homerun';

// Temporary bypass for sleep mode when bed occupancy sensor gives a false negative.
// Double-press Adam's bedroom button to force sleep mode without checking the bed sensor.
// See: sleep-mode-button.ts for the primary (sensor-gated) path.
export default defineAutomation({
  id: 'bedroom:sleep_mode_bypass',
  location: 'bedroom',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: 'sensor.bedroom_button_adam_action', gesture: 'double_press' },
  ],

  context: (state) => {
    const houseMode = requireState(state, 'sensor.house_active_mode');

    return {
      houseMode,
    };
  },

  reduce: (ctx) => {
    if (ctx.houseMode === 'sleep') {
      return { decision: 'no_action', reason: 'already_in_sleep_mode', actions: [] };
    }

    return {
      decision: 'set_sleep_bypass',
      reason: 'double_press_bypass',
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep', impliesEntity: 'sensor.house_active_mode' },
      ],
    };
  },
});
