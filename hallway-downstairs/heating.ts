import { makeHeatingAutomation } from '../lib/heating-controller-factory.js';
import { HOUSE_SCHEDULE_CONTEXTS } from '../lib/house/schedule-contexts.js';

export default makeHeatingAutomation({
  location: 'hallway_downstairs',
  contexts: HOUSE_SCHEDULE_CONTEXTS,
  scheduleConfig: {
    byContext: {
      default: [
        { start: '06:00', end: '22:00', mode: 'baseline_day' },
        { start: '22:00', end: '06:00', mode: 'baseline_night' },
      ],
    },
  },
});
