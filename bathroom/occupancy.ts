import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'bathroom',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.bathroom_sensor_door_contact' },
  ],
});
