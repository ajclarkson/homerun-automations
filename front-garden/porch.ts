import { makePorchLightAutomation } from '../lib/porch-light-factory.js';

// Porch warms on motion after dark in every theme, then fades back to the theme's look.
// The restore scene id avoids the front_garden_ prefix so the theme effects never see it.
export default makePorchLightAutomation({
  location: 'front_garden',
  warm: { colorTempKelvin: 2700, brightness: 180 },
  fadeUpS: 2,
  fadeDownS: 5,
  restoreSceneId: 'front_porch_motion_restore',
});
