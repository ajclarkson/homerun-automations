import { defineAutomation } from 'homerun';

export default defineAutomation({
  id: 'hello-world',
  location: 'house',
  subsystem: 'test',

  triggers: [
    { type: 'on_start' },
  ],

  context: (_state, _ha) => {
    return { message: 'homerun is running' };
  },

  reduce: (ctx) => ({
    decision: 'log',
    reason: ctx.message,
    actions: [],
  }),
});
