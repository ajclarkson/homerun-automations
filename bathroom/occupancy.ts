import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'bathroom',
  extraTriggers: [
    { type: 'state_changed', entity: 'binary_sensor.bathroom_sensor_door_contact' },
    // Water running proves presence; the end of the shower starts the normal clear timer.
    { type: 'state_changed', entity: 'binary_sensor.bathroom_shower' },
  ],
});
