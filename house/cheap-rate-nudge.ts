import { defineAutomation, abort } from '@ajclarkson/homerun';

const CHEAPEST_2H = 'binary_sensor.octopus_energy_target_cheapest_2h_waking_hours';
const NEGATIVE_WINDOWS = 'sensor.octopus_today_negative_windows';

interface NotifyPayload {
  title: string;
  message: string;
}

function buildNotification(
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

function notifyAction(service: string, payload: NotifyPayload) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    target: { entity_id: `notify.${service}` },
    data: { title: payload.title, message: payload.message, data: { url: '/mobile-dashboard/energy' } },
  };
}

export default defineAutomation({
  id: 'house:cheap_rate_nudge',
  location: 'house',
  subsystem: 'energy',

  triggers: [
    { type: 'schedule', cron: '0 9 * * *' },
  ],

  context: (state) => {
    const cheapest = state(CHEAPEST_2H);
    const nextTime = cheapest?.attributes?.['next_time'] as string | undefined;
    const nextRate = cheapest?.attributes?.['next_average_value'] as number | undefined;

    if (!nextTime || nextRate === undefined || nextRate === null) {
      return abort('cheapest_window_data_unavailable');
    }

    const negWindows = state(NEGATIVE_WINDOWS)?.state;
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
    const notification = buildNotification(negWindows, nextTime, nextRate);

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
