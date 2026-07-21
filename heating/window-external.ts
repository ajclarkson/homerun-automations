import { defineAutomation, abort, HomeAssistant } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

export default defineAutomation({
  id: 'house:window_external',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: /^binary_sensor\..+_external_openings$/ },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => {
    let targetRooms: readonly string[];
    if (event.type === 'state_changed') {
      const match = event.entity_id.match(/^binary_sensor\.(.+)_external_openings$/);
      const room = match?.[1];
      targetRooms = room && HEATING_ROOMS.includes(room) ? [room] : [];
    } else {
      targetRooms = HEATING_ROOMS;
    }

    const windows = targetRooms.map(room => ({
      room,
      switchEntity: `switch.${room}_trv_window_open_external`,
      open: state(`binary_sensor.${room}_external_openings`)?.state === 'on',
    }));

    return { windows, inputs: { windows } };
  },

  reduce: (ctx) => {
    const actions = ctx.windows.map(({ switchEntity, open }) =>
      open
        ? HomeAssistant.switch.turn_on({ entity_id: switchEntity })
        : HomeAssistant.switch.turn_off({ entity_id: switchEntity }),
    );

    const summary = ctx.windows.map(({ room, open }) => `${room}:${open ? 'open' : 'closed'}`).join(';');

    return {
      decision: 'sync_window_external',
      reason: summary || 'no_rooms',
      inputs: ctx.inputs,
      actions,
    };
  },
});
