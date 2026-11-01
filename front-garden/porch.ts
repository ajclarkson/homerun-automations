import { makePorchLightAutomation } from '../lib/porch-light-factory.js';

// Porch warms on motion after dark in every theme, then fades back to the theme's look.
// The look to fade back to is saved in input_text.front_garden_automation_porch_restore.
export default makePorchLightAutomation({
  location: 'front_garden',
  warm: { colorTempKelvin: 2700, brightness: 180 },
  fadeUpS: 2,
  fadeDownS: 5,
});
