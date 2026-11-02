import { defineAutomation, abort, HomeAssistant, type DeclaredDecision } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

// Mirroring a window sensor onto the TRV's window switch is a sync: `ignored`. The heating
// controller reports the notable part (a confirmed open window forcing minimum). One event covers
// one room (`room` fact); startup covers all, so its fact is the comma-joined open rooms.
export const WINDOW_EXTERNAL_REASONS = {
  window_open: { outcome: 'ignored', facts: ['room'] },
  window_closed: { outcome: 'ignored', facts: ['room'] },
  windows_synced: { outcome: 'ignored', facts: ['open_rooms'] },
  no_rooms: { outcome: 'ignored' },
} as const;

type WindowExternalDecision = DeclaredDecision<typeof WINDOW_EXTERNAL_REASONS>;

export default defineAutomation({
  reasons: WINDOW_EXTERNAL_REASONS,
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
      open: state(`binary_sensor.${room}_external_openings` as keyof HAEntities)?.state === 'on',
    }));

    return { windows };
  },

  reduce: (ctx): WindowExternalDecision => {
    const actions = ctx.windows.map(({ switchEntity, open }) =>
      open
        ? HomeAssistant.switch.turn_on({ entity_id: switchEntity })
        : HomeAssistant.switch.turn_off({ entity_id: switchEntity }),
    );

    const decision = 'sync_window_external';
    const [only] = ctx.windows;
    if (ctx.windows.length === 0) return { decision, reason: 'no_rooms', actions };
    if (ctx.windows.length === 1) {
      return { decision, reason: only.open ? 'window_open' : 'window_closed', facts: { room: only.room }, actions };
    }
    const openRooms = ctx.windows.filter(w => w.open).map(w => w.room).join(',');
    return { decision, reason: 'windows_synced', facts: { open_rooms: openRooms === '' ? null : openRooms }, actions };
  },
});
