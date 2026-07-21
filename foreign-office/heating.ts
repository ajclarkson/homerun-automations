import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';

export default makeHeatingAutomation({
  location: 'foreign_office',
  independent: true,
  scheduleConfig: {
    byContext: {
      weekday_wfh_adam: [
        { start: '07:15', end: '22:00', mode: 'baseline_day' },
        { start: '22:00', end: '07:15', mode: 'minimum' },
      ],
      default: [
        { start: '00:00', end: '12:00', mode: 'minimum' },
        { start: '12:00', end: '00:00', mode: 'minimum' },
      ],
    },
  },
});
