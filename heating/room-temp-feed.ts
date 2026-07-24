import { defineAutomation, abort, requireNumericState } from '@ajclarkson/homerun';
import { HEATING_ROOMS } from '../lib/heating-rooms.js';

const MIN_ROOM_TEMP_C = 0;
const MAX_ROOM_TEMP_C = 40;

function makeTempFeedAutomation(location: string) {
  const sensorEntity = `sensor.${location}_sensor_climate_temperature`;

  return defineAutomation({
    id: `${location}:room_temp_feed`,
    location,
    subsystem: 'heating',

    triggers: [
      { type: 'state_changed', entity: sensorEntity as keyof HAEntities },
      { type: 'schedule', cron: '*/30 * * * *' },
    ],

    context: (state, _ha, event) => {
      const temp = requireNumericState(state, sensorEntity as keyof HAEntities);
      if (temp < MIN_ROOM_TEMP_C || temp > MAX_ROOM_TEMP_C) return abort(`temp_out_of_range:${temp}`);
      return { temp, reason: event.type === 'schedule' ? 'heartbeat' : 'temp_changed', sensorEntity };
    },

    reduce: (ctx) => ({
      decision: 'update_external_temp',
      reason: ctx.reason,
      actions: [{
        type: 'ha.call_service',
        domain: 'number',
        service: 'set_value',
        target: { entity_id: `number.${location}_trv_external_measured_room_sensor` },
        data: { value: Math.round(ctx.temp * 100) },
      }],
    }),
  });
}

export default HEATING_ROOMS.map(location => makeTempFeedAutomation(location));
