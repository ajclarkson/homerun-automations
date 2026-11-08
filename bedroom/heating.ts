import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';
import { HOUSE_SCHEDULE_CONTEXTS } from '../lib/house/schedule-contexts.js';

export default makeHeatingAutomation({
  location: 'bedroom',
  contexts: HOUSE_SCHEDULE_CONTEXTS,
  scheduleConfig: {
    byContext: {
      default: [
        { start: '06:00', end: '09:00', mode: 'comfort' },
        { start: '09:00', end: '19:00', mode: 'baseline_day' },
        { start: '19:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
