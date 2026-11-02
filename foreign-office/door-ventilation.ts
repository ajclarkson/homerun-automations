import { defineAutomation, abort, type DeclaredDecision } from '@ajclarkson/homerun';

// Telling a person to open or close the door is what `acted` means here; the temperatures are
// whole degrees so the sentence never shows 24.700000001.
export const DOOR_VENTILATION_REASONS = {
  open_door: { outcome: 'acted', facts: ['indoor', 'outdoor'] },
  close_door: { outcome: 'acted', facts: ['indoor', 'outdoor'] },
  not_active: { outcome: 'ignored' },
  conditions_not_met: { outcome: 'ignored' },
} as const;

type DoorVentilationDecision = DeclaredDecision<typeof DOOR_VENTILATION_REASONS>;

export default defineAutomation({
  reasons: DOOR_VENTILATION_REASONS,
  id: 'foreign_office:door_ventilation',
  location: 'foreign_office',
  subsystem: 'thermal',

  triggers: [
    { type: 'on_start' },
    { type: 'state_changed', entity: 'sensor.foreign_office_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'weather.forecast_home' },
    { type: 'state_changed', entity: 'binary_sensor.foreign_office_sensor_door_contact' },
    { type: 'state_changed', entity: 'binary_sensor.foreign_office_occupied' },
    { type: 'state_changed', entity: 'input_boolean.wfh_adam' },
  ],

  context: (state) => {
    const openDelta    = parseFloat(state('input_number.foreign_office_automation_door_open_delta')?.state ?? '');
    const minOutdoor   = parseFloat(state('input_number.foreign_office_automation_door_open_min_outdoor')?.state ?? '');
    const comfortThreshold = parseFloat(state('input_number.foreign_office_automation_door_indoor_comfort_threshold')?.state ?? '');
    const cooldownMins = parseInt(state('input_number.foreign_office_automation_door_notification_cooldown_mins')?.state ?? '', 10);
    const foIndoorTemp = parseFloat(state('sensor.foreign_office_sensor_climate_temperature')?.state ?? '');
    const outdoorTemp  = state('weather.forecast_home')?.attributes?.['temperature'] as number | undefined;

    const required = { openDelta, minOutdoor, comfortThreshold, cooldownMins, foIndoorTemp };
    for (const [name, val] of Object.entries(required)) {
      if (!Number.isFinite(val)) return abort(`sensor_unavailable:${name}`);
    }
    if (outdoorTemp === undefined || !Number.isFinite(outdoorTemp)) {
      return abort('sensor_unavailable:outdoorTemp');
    }

    const fanPower   = parseFloat(state('sensor.foreign_office_plug_fan_power')?.state ?? '');
    const doorOpen   = state('binary_sensor.foreign_office_sensor_door_contact')?.state === 'on';
    const foOccupied = state('binary_sensor.foreign_office_occupied')?.state === 'on';
    const wfhAdam    = state('input_boolean.wfh_adam')?.state === 'on';

    const lastOpenSent  = state('input_text.foreign_office_notification_door_open_last')?.state  ?? '';
    const lastCloseSent = state('input_text.foreign_office_notification_door_close_last')?.state ?? '';

    const now = Date.now();
    const cooldownMs = cooldownMins * 60 * 1000;
    const openCooldownActive  = !!lastOpenSent  && (now - new Date(lastOpenSent).getTime())  < cooldownMs;
    const closeCooldownActive = !!lastCloseSent && (now - new Date(lastCloseSent).getTime()) < cooldownMs;

    const outdoorCoolerThanIndoor = outdoorTemp < foIndoorTemp - openDelta;
    const outdoorTooCold          = outdoorTemp < minOutdoor;
    const indoorActuallyWarm      = foIndoorTemp >= comfortThreshold;
    const outdoorWarmerThanIndoor = outdoorTemp >= foIndoorTemp;
    const fanRunning = Number.isFinite(fanPower) && fanPower > 10;

    return {
      foIndoorTemp,
      outdoorTemp,
      doorOpen,
      foOccupied,
      wfhAdam,
      openDelta,
      cooldownMins,
      openCooldownActive,
      closeCooldownActive,
      outdoorCoolerThanIndoor,
      outdoorTooCold,
      indoorActuallyWarm,
      outdoorWarmerThanIndoor,
      fanRunning,
      fanPower,
    };
  },

  reduce: (ctx): DoorVentilationDecision => {
    const {
      foIndoorTemp, outdoorTemp,
      doorOpen, foOccupied, wfhAdam,
      openCooldownActive, closeCooldownActive,
      outdoorCoolerThanIndoor, outdoorTooCold, indoorActuallyWarm, outdoorWarmerThanIndoor,
      fanRunning,
    } = ctx;

    if (!foOccupied || !wfhAdam) {
      return { decision: 'no_action', reason: 'not_active', actions: [] };
    }

    const facts = { indoor: Math.round(foIndoorTemp), outdoor: Math.round(outdoorTemp) };
    const nowIso = new Date().toISOString();

    if (outdoorCoolerThanIndoor && indoorActuallyWarm && !outdoorTooCold && !doorOpen && !openCooldownActive) {
      const ventMessage = fanRunning
        ? `Indoor ${foIndoorTemp}°C vs outside ${outdoorTemp}°C — open the door to help the fan vent`
        : `Indoor ${foIndoorTemp}°C vs outside ${outdoorTemp}°C — open the door to let cooler air in`;

      return {
        decision: 'notify',
        reason: 'open_door',
        facts,
        actions: [
          {
            type: 'ha.call_service',
            domain: 'input_text',
            service: 'set_value',
            target: { entity_id: 'input_text.foreign_office_notification_door_open_last' },
            data: { value: nowIso },
          },
          {
            type: 'ha.call_service',
            domain: 'notify',
            service: 'mobile_app_adams_iphone',
            data: { title: 'Open the foreign office door', message: ventMessage },
          },
        ],
      };
    }

    if (outdoorWarmerThanIndoor && doorOpen && !closeCooldownActive) {
      return {
        decision: 'notify',
        reason: 'close_door',
        facts,
        actions: [
          {
            type: 'ha.call_service',
            domain: 'input_text',
            service: 'set_value',
            target: { entity_id: 'input_text.foreign_office_notification_door_close_last' },
            data: { value: nowIso },
          },
          {
            type: 'ha.call_service',
            domain: 'notify',
            service: 'mobile_app_adams_iphone',
            data: {
              title: 'Close the foreign office door',
              message: `Outside (${outdoorTemp}°C) is warmer than indoors — close the door to keep the heat out`,
            },
          },
        ],
      };
    }

    return { decision: 'no_action', reason: 'conditions_not_met', actions: [] };
  },
});
