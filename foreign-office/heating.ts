import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'foreign_office',
  independent: true,
  scheduleConfig: {
    byContext: {
      weekday_wfh_adam: [
        { start: '07:15', end: '08:30', mode: 'baseline_day' },
        { start: '08:30', end: '22:00', mode: 'minimum', occupiedMode: 'baseline_day' },
        { start: '22:00', end: '07:15', mode: 'minimum' },
      ],
      default: [
        { start: '06:00', end: '22:00', mode: 'minimum', occupiedMode: 'baseline_day' },
        { start: '22:00', end: '06:00', mode: 'minimum' },
      ],
    },
  },
});
