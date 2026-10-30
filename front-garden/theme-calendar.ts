import { makeThemeCalendarAutomation } from '../lib/theme-calendar.js';

// Which light theme the front garden follows through the year. Switches only on the days the
// calendar's answer changes, so a theme picked by hand on the dashboard sticks until then.
// Overlaps resolve to the shortest entry (Bonfire Night wins over Autumn). Off via the
// "Follow calendar" toggle (input_boolean.front_garden_light_theme_calendar_enabled).
export default makeThemeCalendarAutomation({
  location: 'front_garden',
  fallback: 'normal',
  calendar: [
    { theme: 'autumn', from: '09-01', to: '11-30' },
    { theme: 'halloween', from: '10-20', to: '10-31' },
    { theme: 'bonfire', on: '11-05' },
    { theme: 'christmas', from: '12-01', to: '12-31' },
  ],
});
