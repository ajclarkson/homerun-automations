import { makeOutdoorLightingAutomation } from '../lib/outdoor-lighting-factory.js';

// Soft tree accents — run until bedtime (sleep mode), with midnight as the backstop.
// previewMinutes: a daytime tap on a theme would otherwise stay on until midnight.
export default makeOutdoorLightingAutomation({ location: 'front_garden', offTime: '00:00', previewMinutes: 10 });
