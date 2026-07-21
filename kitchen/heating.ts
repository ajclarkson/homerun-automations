import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'kitchen',
  scheduleConfig: {
    byContext: {
      default: [
        { start: '06:00', end: '09:00', mode: 'comfort' },
        { start: '09:00', end: '11:30', mode: 'baseline_day' },
        { start: '11:30', end: '13:00', mode: 'comfort' },
        { start: '13:00', end: '18:00', mode: 'baseline_day' },
        { start: '18:00', end: '20:00', mode: 'comfort' },
        { start: '20:00', end: '22:00', mode: 'baseline_day' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
