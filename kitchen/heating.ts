import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';
import { HOUSE_SCHEDULE_CONTEXTS } from '../lib/house/schedule-contexts.js';

export default makeHeatingAutomation({
  location: 'kitchen',
  contexts: HOUSE_SCHEDULE_CONTEXTS,
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
