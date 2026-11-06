import { defineAutomation, abort, type DeclaredDecision } from '@ajclarkson/homerun';

function notifyAction(service: string, title: string, message: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    data: { title, message },
  };
}

function setInputText(entity: string, value: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'input_text',
    service: 'set_value',
    target: { entity_id: entity },
    data: { value },
  };
}

// A notification telling someone to open or close windows is the outcome (`acted`); the hot-event
// bookkeeping rides along on quiet runs.
export const WINDOW_THERMAL_REASONS = {
  close_both: { outcome: 'acted' },
  close_bedroom: { outcome: 'acted' },
  close_home_office: { outcome: 'acted' },
  open_both: { outcome: 'acted' },
  nobody_home: { outcome: 'ignored' },
  conditions_not_met: { outcome: 'ignored' },
} as const;

type WindowThermalDecision = DeclaredDecision<typeof WINDOW_THERMAL_REASONS>;

export default defineAutomation({
  reasons: WINDOW_THERMAL_REASONS,
  id: 'house:window_thermal',
  location: 'house',
  subsystem: 'thermal',

  triggers: [
    { type: 'on_start' },
    { type: 'state_changed', entity: 'sensor.bedroom_sensor_window_right_device_temperature' },
    { type: 'state_changed', entity: 'sensor.bedroom_sensor_window_left_device_temperature' },
    { type: 'state_changed', entity: 'sensor.bedroom_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'sensor.home_office_sensor_climate_temperature' },
    { type: 'state_changed', entity: 'weather.forecast_home' },
    { type: 'state_changed', entity: 'binary_sensor.bedroom_external_openings' },
    { type: 'state_changed', entity: 'binary_sensor.home_office_external_openings' },
  ],

  context: (state) => {
    const frameThreshold   = parseFloat(state('input_number.bedroom_automation_window_frame_threshold')?.state ?? '');
    const openDelta        = parseFloat(state('input_number.bedroom_automation_window_open_delta')?.state ?? '');
    const openHour         = parseInt(state('input_number.bedroom_automation_window_open_hour')?.state ?? '', 10);
    const comfortThreshold = parseFloat(state('input_number.bedroom_automation_window_indoor_comfort_threshold')?.state ?? '');
    const hoComfortThreshold = parseFloat(state('input_number.home_office_automation_window_indoor_comfort_threshold')?.state ?? '');
    const rightTemp        = parseFloat(state('sensor.bedroom_sensor_window_right_device_temperature')?.state ?? '');
    const leftTemp         = parseFloat(state('sensor.bedroom_sensor_window_left_device_temperature')?.state ?? '');
    const hoIndoorTemp     = parseFloat(state('sensor.home_office_sensor_climate_temperature')?.state ?? '');
    const bedroomTemp      = parseFloat(state('sensor.bedroom_sensor_climate_temperature')?.state ?? '');
    const outdoorTemp      = state('weather.forecast_home')?.attributes?.['temperature'] as number | undefined;

    const required = { frameThreshold, openDelta, openHour, comfortThreshold, hoComfortThreshold, rightTemp, leftTemp, hoIndoorTemp, bedroomTemp };
    for (const [name, val] of Object.entries(required)) {
      if (!Number.isFinite(val)) return abort(`sensor_unavailable:${name}`);
    }
    if (outdoorTemp === undefined || !Number.isFinite(outdoorTemp)) {
      return abort('sensor_unavailable:outdoorTemp');
    }

    const today = new Date().toISOString().slice(0, 10);
    const hour  = new Date().getHours();

    const maxDeviceTemp   = Math.max(rightTemp, leftTemp);
    const avgIndoorTemp   = (hoIndoorTemp + bedroomTemp) / 2;
    const bedroomOpen     = state('binary_sensor.bedroom_external_openings')?.state === 'on';
    const hoOpen          = state('binary_sensor.home_office_external_openings')?.state === 'on';
    const bedroomFrameHot        = maxDeviceTemp >= frameThreshold;
    const outsideWarmerThanHO    = outdoorTemp > hoIndoorTemp;
    const outsideWarmerThanBedroom = outdoorTemp > bedroomTemp;
    const bedroomActuallyWarm    = bedroomTemp >= comfortThreshold;
    const hoActuallyWarm         = hoIndoorTemp >= hoComfortThreshold;
    const outsideCooler          = outdoorTemp < avgIndoorTemp - openDelta;
    const openWindowAllowed      = hour >= openHour;
    const eitherClosed           = !bedroomOpen || !hoOpen;

    const sentCloseBedroom = state('input_text.window_notification_close_bedroom')?.state;
    const sentCloseHO      = state('input_text.window_notification_close_home_office')?.state;
    const sentCloseBoth    = state('input_text.window_notification_close_both')?.state;
    const sentOpenBoth     = state('input_text.window_notification_open_both')?.state;
    const hotEventToday    = state('input_text.window_thermal_hot_event')?.state === today;

    const adamHome  = state('person.adam')?.state === 'home';
    const sarahHome = state('person.sarah')?.state === 'home';

    return {
      today,
      maxDeviceTemp,
      outdoorTemp,
      avgIndoorTemp,
      bedroomOpen,
      hoOpen,
      bedroomFrameHot,
      outsideWarmerThanHO,
      outsideWarmerThanBedroom,
      bedroomActuallyWarm,
      hoActuallyWarm,
      outsideCooler,
      openWindowAllowed,
      eitherClosed,
      sentCloseBedroom,
      sentCloseHO,
      sentCloseBoth,
      sentOpenBoth,
      hotEventToday,
      adamHome,
      sarahHome,
    };
  },

  reduce: (ctx): WindowThermalDecision => {
    const {
      today, maxDeviceTemp, outdoorTemp, avgIndoorTemp,
      bedroomOpen, hoOpen,
      bedroomFrameHot, outsideWarmerThanHO, outsideWarmerThanBedroom, bedroomActuallyWarm, hoActuallyWarm, outsideCooler,
      openWindowAllowed, eitherClosed, hotEventToday,
      sentCloseBedroom, sentCloseHO, sentCloseBoth, sentOpenBoth,
      adamHome, sarahHome,
    } = ctx;

    // Side effect: record a hot event whenever conditions are warm, regardless of notification
    const hotEventActions = (bedroomFrameHot || outsideWarmerThanHO)
      ? [setInputText('input_text.window_thermal_hot_event', today)]
      : [];

    let decision = 'no_action';
    let reason: keyof typeof WINDOW_THERMAL_REASONS = 'conditions_not_met';
    let title = 'uninitialised';
    let message = 'uninitialised';
    let dedupeEntity = 'uninitialised';

    const closeSentToday = sentCloseBedroom === today || sentCloseHO === today || sentCloseBoth === today;

    if (bedroomFrameHot && outsideWarmerThanHO && (bedroomOpen || hoOpen) && !closeSentToday) {
      decision = 'notify';
      reason = 'close_both';
      title = 'Close bedroom and home office windows';
      message = `South frames at ${maxDeviceTemp}°C and outside air is warmer than indoors`;
      dedupeEntity = 'input_text.window_notification_close_both';
    } else if (bedroomFrameHot && outsideWarmerThanBedroom && bedroomActuallyWarm && bedroomOpen && sentCloseBedroom !== today && sentCloseBoth !== today) {
      decision = 'notify';
      reason = 'close_bedroom';
      title = 'Close the bedroom windows';
      message = `Window frames at ${maxDeviceTemp}°C — south sun is building`;
      dedupeEntity = 'input_text.window_notification_close_bedroom';
    } else if (outsideWarmerThanHO && hoActuallyWarm && hoOpen && sentCloseHO !== today && sentCloseBoth !== today) {
      decision = 'notify';
      reason = 'close_home_office';
      title = 'Close the home office windows';
      message = `Outside air (${outdoorTemp}°C) is warmer than indoors`;
      dedupeEntity = 'input_text.window_notification_close_home_office';
    } else if (outsideCooler && !bedroomFrameHot && eitherClosed && openWindowAllowed && hotEventToday && sentOpenBoth !== today) {
      const delta = (avgIndoorTemp - outdoorTemp).toFixed(1);
      decision = 'notify';
      reason = 'open_both';
      title = 'Open the windows';
      message = `Outside is ${delta}°C cooler — open bedroom and home office for cross-ventilation`;
      dedupeEntity = 'input_text.window_notification_open_both';
    }

    if (decision !== 'notify') {
      return { decision, reason, actions: hotEventActions };
    }

    const notifyActions = [
      ...(adamHome  ? [notifyAction('mobile_app_adams_iphone',  title, message)] : []),
      ...(sarahHome ? [notifyAction('mobile_app_sarahs_iphone', title, message)] : []),
    ];

    // A nudge with nobody to read it is not sent. The dedupe stamp is left unset so the same nudge
    // can still go out later today once someone is home.
    if (notifyActions.length === 0) {
      return { decision: 'no_action', reason: 'nobody_home', actions: hotEventActions };
    }

    return {
      decision,
      reason,
      actions: [
        ...hotEventActions,
        setInputText(dedupeEntity, today),
        ...notifyActions,
      ],
    };
  },
});
