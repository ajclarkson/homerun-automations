import { makeThemeEffectsAutomation } from '../lib/theme-effects-factory.js';

// On-bulb Hue effects per theme. Roles come from the outdoor_light_feature / outdoor_light_accent labels.
// Fireplace runs at full brightness: at the scene's level it read as too subtle (tested on 31 Oct).
const FIREPLACE = { effect: 'fireplace', brightness: 255 };

export default makeThemeEffectsAutomation({
  location: 'front_garden',
  themes: {
    halloween: { accent: FIREPLACE },
    bonfire: { feature: FIREPLACE, accent: FIREPLACE },
  },
});
