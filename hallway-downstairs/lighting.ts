import { makeLightingAutomation } from '../lighting/lighting-controller-factory.js';

export default makeLightingAutomation({
  location: 'hallway_downstairs',
  disableInSleepMode: true,
});
