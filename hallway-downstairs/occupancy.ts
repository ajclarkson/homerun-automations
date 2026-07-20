import { makeOccupancyAutomation } from '../lib/occupancy-controller-factory.js';

export default makeOccupancyAutomation({
  location: 'hallway_downstairs',
  delayMins: 2,
});
