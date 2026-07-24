import { defineAutomation, abort } from '@ajclarkson/homerun';
import type { TriggerEvent } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:exit_sleep_button',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: /.*_button_.*_action/, gesture: 'single_press' },
  ],

  context: (state, _ha, event: TriggerEvent) => {
    if (event.type !== 'button') return abort('unexpected_trigger_type');

    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    const entityId = event.entity_id;
    const isBedroomButton = entityId.startsWith('sensor.bedroom_button');
    const isHomeOfficeButton = entityId.startsWith('sensor.home_office_button');

    let bedOccupied: boolean | null = null;
    if (isBedroomButton) {
      const bedState = state('binary_sensor.bedroom_sensor_bed_occupancy')?.state;
      if (!bedState || bedState === 'unavailable' || bedState === 'unknown') {
        return abort(`bed_sensor_unavailable:${bedState}`);
      }
      bedOccupied = bedState === 'on';
    }

    let guestModeActive: boolean | null = null;
    if (isHomeOfficeButton) {
      const modifier = state('input_select.house_active_mode_modifier')?.state;
      if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
        return abort(`modifier_unavailable:${modifier}`);
      }
      guestModeActive = modifier === 'guest';
    }

    return {
      houseMode,
      isBedroomButton,
      isHomeOfficeButton,
      bedOccupied,
      guestModeActive,
    };
  },

  reduce: (ctx) => {
    if (ctx.houseMode !== 'sleep') {
      return { decision: 'no_action', reason: 'not_in_sleep_mode', actions: [] };
    }
    if (ctx.isBedroomButton && ctx.bedOccupied) {
      return { decision: 'no_action', reason: 'bed_occupied', actions: [] };
    }
    if (ctx.isHomeOfficeButton && ctx.guestModeActive) {
      return { decision: 'no_action', reason: 'guest_mode_active', actions: [] };
    }
    return {
      decision: 'exit_sleep',
      reason: 'button_pressed',
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' },
      ],
    };
  },
});
