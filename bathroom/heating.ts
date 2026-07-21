import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'bathroom',
  scheduleConfig: {
    byContext: {
      default: [
        { start: '06:00', end: '09:00', mode: 'comfort' },
        { start: '09:00', end: '21:00', mode: 'baseline_day' },
        { start: '21:00', end: '23:00', mode: 'comfort' },
        { start: '23:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
