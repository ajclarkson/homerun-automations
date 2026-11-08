import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';
import { HOUSE_SCHEDULE_CONTEXTS } from '../lib/house/schedule-contexts.js';

export default makeHeatingAutomation({
  location: 'bathroom',
  contexts: HOUSE_SCHEDULE_CONTEXTS,
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
