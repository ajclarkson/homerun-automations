import { makeOutdoorLightingAutomation } from '../lib/outdoor-lighting-factory.js';

// Soft tree accents — run until bedtime (sleep mode), with midnight as the backstop.
export default makeOutdoorLightingAutomation({ location: 'front_garden', offTime: '00:00' });
