import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'bedroom',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.bedroom_sensor_door_contact' },
    { type: 'state_changed', entity: 'binary_sensor.bedroom_bed_occupied' },
  ],
});
