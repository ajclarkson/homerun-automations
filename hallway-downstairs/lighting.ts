import { makeLightingAutomation } from '../lib/lighting-controller-factory.js';

export default makeLightingAutomation({
  location: 'hallway_downstairs',
  disableInSleepMode: true,
});
