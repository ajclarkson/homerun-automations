import { makeThemeEffectsAutomation } from '../lib/theme-effects-factory.js';

// On-bulb Hue effects per theme. Roles come from the outdoor_light_feature / outdoor_light_accent labels.
export default makeThemeEffectsAutomation({
  location: 'front_garden',
  themes: {
    halloween: { accent: 'fireplace' },
  },
});
