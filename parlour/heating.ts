import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'parlour',
  scheduleConfig: {
    byContext: {
      weekday: [
        { start: '06:00', end: '16:15', mode: 'baseline_day' },
        { start: '16:15', end: '22:00', mode: 'comfort' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
      weekend: [
        { start: '06:00', end: '22:00', mode: 'comfort' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
