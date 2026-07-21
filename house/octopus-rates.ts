import { defineAutomation, abort } from '@ajclarkson/homerun';

interface NotifyPayload {
  title: string;
  message: string;
}

function notifyAction(service: string, payload: NotifyPayload) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    target: { entity_id: `notify.${service}` },
    data: { title: payload.title, message: payload.message, data: { url: '/mobile-dashboard/energy' } },
  };
}

// Today: fires at 09:00, notifies whoever is home with today's cheapest 2h window
const cheapRateNudge = defineAutomation({
  id: 'house:cheap_rate_nudge',
  location: 'house',
  subsystem: 'energy',

  triggers: [
    { type: 'schedule', cron: '0 9 * * *' },
  ],

  context: (state) => {
    const cheapest = state('binary_sensor.octopus_energy_target_cheapest_2h_waking_hours');
    const nextTime = cheapest?.attributes?.['next_time'] as string | undefined;
    const nextRate = cheapest?.attributes?.['next_average_value'] as number | undefined;

    if (!nextTime || nextRate === undefined || nextRate === null) {
      return abort('cheapest_window_data_unavailable');
    }

    const negWindows = state('sensor.octopus_today_negative_windows')?.state;
    const adamHome = state('person.adam')?.state === 'home';
    const sarahHome = state('person.sarah')?.state === 'home';

    return {
      nextTime,
      nextRate,
      negWindows,
      adamHome,
      sarahHome,
      inputs: { nextTime, nextRate, negWindows, adamHome, sarahHome },
    };
  },

  reduce: (ctx) => {
    const { nextTime, nextRate, negWindows, adamHome, sarahHome } = ctx;

    const notification = buildTodayNotification(negWindows, nextTime, nextRate);

    const actions = [
      ...(adamHome  ? [notifyAction('mobile_app_adams_iphone',  notification)] : []),
      ...(sarahHome ? [notifyAction('mobile_app_sarahs_iphone', notification)] : []),
    ];

    const decision = actions.length > 0 ? 'notify' : 'no_action';
    const reason = actions.length > 0
      ? [adamHome && 'adam', sarahHome && 'sarah'].filter(Boolean).join('_and_')
      : 'nobody_home';

    return { decision, reason, inputs: ctx.inputs, actions };
  },
});

function buildTodayNotification(
  negWindows: string | undefined,
  nextTime: string,
  nextRate: number,
): NotifyPayload {
  const hasNeg = negWindows && negWindows !== '—';

  if (hasNeg) {
    const firstNeg = negWindows!.split(' · ')[0];
    const hasMore = negWindows!.includes(' · ');
    return {
      title: '⚡ Free electricity today',
      message: firstNeg + (hasMore ? ' + more windows — tap for details' : ' — tap for all windows'),
    };
  }

  const timeStr = new Date(nextTime).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  const rateStr = (nextRate * 100).toFixed(1);
  return {
    title: "Today's cheapest electricity",
    message: `${timeStr} for 2 hours at ${rateStr}p/kWh — worth waiting to run the dishwasher or washing machine`,
  };
}

// Tomorrow: fires when Octopus publishes tomorrow's rates (after 4pm), notifies both
// people if there are any negative or sub-10p windows worth knowing about.
const tomorrowRatesNudge = defineAutomation({
  id: 'house:tomorrow_rates_nudge',
  location: 'house',
  subsystem: 'energy',

  triggers: [
    { type: 'state_changed', entity: 'binary_sensor.octopus_tomorrow_data_available' },
  ],

  context: (state) => {
    const available = state('binary_sensor.octopus_tomorrow_data_available')?.state;

    if (available !== 'on') return abort('tomorrow_data_not_available');

    const negWindows   = state('sensor.octopus_tomorrow_negative_windows')?.state;
    const cheapWindows = state('sensor.octopus_tomorrow_cheap_windows')?.state;

    const hasNeg   = !!(negWindows   && negWindows   !== '—');
    const hasCheap = !!(cheapWindows && cheapWindows !== '—');

    return {
      negWindows,
      cheapWindows,
      hasNeg,
      hasCheap,
      inputs: { negWindows, cheapWindows, hasNeg, hasCheap },
    };
  },

  reduce: (ctx) => {
    const { negWindows, cheapWindows, hasNeg, hasCheap } = ctx;

    if (!hasNeg && !hasCheap) {
      return { decision: 'no_action', reason: 'no_notable_windows_tomorrow', inputs: ctx.inputs, actions: [] };
    }

    const notification = buildTomorrowNotification(negWindows, cheapWindows, hasNeg, hasCheap);

    return {
      decision: 'notify',
      reason: hasNeg ? 'negative_windows' : 'cheap_windows',
      inputs: ctx.inputs,
      actions: [
        notifyAction('mobile_app_adams_iphone',  notification),
        notifyAction('mobile_app_sarahs_iphone', notification),
      ],
    };
  },
});

function buildTomorrowNotification(
  negWindows: string | undefined,
  cheapWindows: string | undefined,
  hasNeg: boolean,
  hasCheap: boolean,
): NotifyPayload {
  if (hasNeg) {
    const firstNeg = negWindows!.split(' · ')[0];
    const hasMore = negWindows!.includes(' · ');
    return {
      title: '⚡ Free electricity tomorrow',
      message: firstNeg + (hasMore ? ' + more windows — tap for details' : (hasCheap ? ' — tap for all windows' : '')),
    };
  }

  const firstCheap = cheapWindows!.split(' · ')[0];
  const hasMore = cheapWindows!.includes(' · ');
  return {
    title: "Tomorrow's cheap rates",
    message: firstCheap + (hasMore ? ' + more — tap for details' : ' — tap for details'),
  };
}

export { cheapRateNudge, tomorrowRatesNudge };
export default [cheapRateNudge, tomorrowRatesNudge];
