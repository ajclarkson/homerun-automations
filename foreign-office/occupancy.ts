import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'foreign_office',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.foreign_office_sensor_door_contact' },
  ],
});
