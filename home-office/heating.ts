import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'home_office',
  scheduleConfig: {
    byContext: {
      weekday: [
        { start: '06:00', end: '17:00', mode: 'comfort' },
        { start: '17:00', end: '22:00', mode: 'baseline_day' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
      default: [
        { start: '06:00', end: '22:00', mode: 'baseline_day' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
