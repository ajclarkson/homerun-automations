import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'parlour',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.parlour_sensor_door_contact' },
    { type: 'state_changed', entity: 'binary_sensor.parlour_sensor_door_patio_contact' },
    { type: 'state_changed', entity: 'binary_sensor.parlour_sensor_sofa_occupancy' },
    { type: 'state_changed', entity: 'binary_sensor.parlour_media_active' },
  ],
});
