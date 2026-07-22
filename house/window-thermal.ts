import { defineAutomation, abort } from '@ajclarkson/homerun';

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

export default defineAutomation({
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
    const frameThreshold = parseFloat(state('input_number.bedroom_automation_window_frame_threshold')?.state ?? '');
    const openDelta      = parseFloat(state('input_number.bedroom_automation_window_open_delta')?.state ?? '');
    const openHour       = parseInt(state('input_number.bedroom_automation_window_open_hour')?.state ?? '', 10);
    const rightTemp      = parseFloat(state('sensor.bedroom_sensor_window_right_device_temperature')?.state ?? '');
    const leftTemp       = parseFloat(state('sensor.bedroom_sensor_window_left_device_temperature')?.state ?? '');
    const hoIndoorTemp   = parseFloat(state('sensor.home_office_sensor_climate_temperature')?.state ?? '');
    const bedroomTemp    = parseFloat(state('sensor.bedroom_sensor_climate_temperature')?.state ?? '');
    const outdoorTemp    = state('weather.forecast_home')?.attributes?.['temperature'] as number | undefined;

    const required = { frameThreshold, openDelta, openHour, rightTemp, leftTemp, hoIndoorTemp, bedroomTemp };
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
    const bedroomFrameHot     = maxDeviceTemp >= frameThreshold;
    const outsideWarmerThanHO = outdoorTemp > hoIndoorTemp;
    const outsideCooler       = outdoorTemp < avgIndoorTemp - openDelta;
    const openWindowAllowed   = hour >= openHour;
    const eitherClosed        = !bedroomOpen || !hoOpen;

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
      inputs: {
        maxDeviceTemp, outdoorTemp, avgIndoorTemp,
        bedroomOpen, hoOpen,
        bedroomFrameHot, outsideWarmerThanHO, outsideCooler,
        openWindowAllowed, eitherClosed, hotEventToday,
        sentCloseBedroom, sentCloseHO, sentCloseBoth, sentOpenBoth,
        adamHome, sarahHome,
      },
    };
  },

  reduce: (ctx) => {
    const {
      today, maxDeviceTemp, outdoorTemp, avgIndoorTemp,
      bedroomOpen, hoOpen,
      bedroomFrameHot, outsideWarmerThanHO, outsideCooler,
      openWindowAllowed, eitherClosed, hotEventToday,
      sentCloseBedroom, sentCloseHO, sentCloseBoth, sentOpenBoth,
      adamHome, sarahHome,
    } = ctx;

    // Side effect: record a hot event whenever conditions are warm, regardless of notification
    const hotEventActions = (bedroomFrameHot || outsideWarmerThanHO)
      ? [setInputText('input_text.window_thermal_hot_event', today)]
      : [];

    let decision = 'no_action';
    let reason = 'conditions_not_met';
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
    } else if (bedroomFrameHot && bedroomOpen && sentCloseBedroom !== today && sentCloseBoth !== today) {
      decision = 'notify';
      reason = 'close_bedroom';
      title = 'Close the bedroom windows';
      message = `Window frames at ${maxDeviceTemp}°C — south sun is building`;
      dedupeEntity = 'input_text.window_notification_close_bedroom';
    } else if (outsideWarmerThanHO && hoOpen && sentCloseHO !== today && sentCloseBoth !== today) {
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
      return { decision, reason, inputs: ctx.inputs, actions: hotEventActions };
    }

    const notifyActions = [
      ...(adamHome  ? [notifyAction('mobile_app_adams_iphone',  title, message)] : []),
      ...(sarahHome ? [notifyAction('mobile_app_sarahs_iphone', title, message)] : []),
    ];

    return {
      decision,
      reason,
      inputs: ctx.inputs,
      actions: [
        ...hotEventActions,
        setInputText(dedupeEntity, today),
        ...notifyActions,
      ],
    };
  },
});
