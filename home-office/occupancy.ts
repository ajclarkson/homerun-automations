import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'home_office',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.home_office_sensor_door_contact' },
  ],
});
