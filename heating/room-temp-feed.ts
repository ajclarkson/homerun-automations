import { defineAutomation, abort } from '@ajclarkson/homerun';

const ROOMS: Array<{ location: string; sensor: string }> = [
  { location: 'parlour',            sensor: 'sensor.parlour_sensor_climate_temperature' },
  { location: 'kitchen',            sensor: 'sensor.kitchen_sensor_climate_temperature' },
  { location: 'hallway_downstairs', sensor: 'sensor.hallway_downstairs_sensor_motion_temperature' },
  { location: 'bedroom',            sensor: 'sensor.bedroom_sensor_climate_temperature' },
  { location: 'bathroom',           sensor: 'sensor.bathroom_sensor_climate_temperature' },
  { location: 'home_office',        sensor: 'sensor.home_office_sensor_climate_temperature' },
];

function makeTempFeedAutomation(location: string, sensorEntity: string) {
  return defineAutomation({
    id: `${location}:room_temp_feed`,
    location,
    subsystem: 'heating',

    triggers: [
      { type: 'state_changed', entity: sensorEntity },
      { type: 'schedule', cron: '*/30 * * * *' },
    ],

    context: (state, _ha, event) => {
      const tempStr = state(sensorEntity)?.state;
      const temp = parseFloat(tempStr ?? '');
      if (!Number.isFinite(temp)) return abort(`temp_unavailable:${tempStr}`);
      return { temp, reason: event.type === 'schedule' ? 'heartbeat' : 'temp_changed', inputs: { sensorEntity, temp } };
    },

    reduce: (ctx) => ({
      decision: 'update_external_temp',
      reason: ctx.reason,
      inputs: ctx.inputs,
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

export default ROOMS.map(({ location, sensor }) => makeTempFeedAutomation(location, sensor));
