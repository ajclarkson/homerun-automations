import { defineAutomation, abort } from '@ajclarkson/homerun';

const POINTS = 'sensor.octopus_energy_a_644e00d3_octoplus_points';

function notifyAction(service: string, message: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    data: { title: '⭐ Octopoints credited', message, data: { url: '/mobile-dashboard/energy' } },
  };
}

// Number('') is 0, so blank states need excluding explicitly
const toNumber = (s: string | undefined) => (s === undefined || s.trim() === '' ? NaN : Number(s));

// Tells both people whenever the Octoplus points balance goes up. The source isn't known — it could
// be a wheel of fortune prize, a power down session reward or anything else — so the message only
// reports the amount and new balance.
export default defineAutomation({
  id: 'house:octopus_points_credited',
  location: 'house',
  subsystem: 'energy',

  triggers: [{ type: 'state_changed', entity: POINTS }],

  context: (_state, _ha, event) => {
    if (event.type !== 'state_changed') return abort('unexpected_event');

    const before = toNumber(event.old_state?.state);
    const after = toNumber(event.new_state?.state);

    // unavailable/unknown states aren't numbers, so a recovering sensor can't read as a credit
    if (!Number.isFinite(before) || !Number.isFinite(after)) return abort('balance_not_numeric');
    if (after <= before) return abort('balance_not_increased');

    return { credited: after - before, balance: after };
  },

  reduce: (ctx) => {
    const message = `+${ctx.credited} octopoints (balance ${ctx.balance})`;
    return {
      decision: 'notify',
      reason: 'points_increased',
      actions: [
        notifyAction('mobile_app_adams_iphone', message),
        notifyAction('mobile_app_sarahs_iphone', message),
      ],
    };
  },
});
