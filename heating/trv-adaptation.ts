import { defineAutomation, abort } from '@ajclarkson/homerun';

export default defineAutomation({
  id: 'house:trv_adaptation',
  location: 'house',
  subsystem: 'heating',

  triggers: [
    { type: 'state_changed', entity: /^sensor\..+_trv_adaptation_run_status$/ },
  ],

  context: (state, _ha, event) => {
    if (event.type !== 'state_changed') return abort('unexpected_trigger_type');

    const entityId = event.entity_id;
    const status = event.new_state.state;

    if (!status || status === 'unavailable' || status === 'unknown') {
      return abort(`status_unavailable:${status}`);
    }

    const room = entityId
      .replace('sensor.', '')
      .replace('_trv_adaptation_run_status', '')
      .replace(/_/g, ' ');

    return { room, status, inputs: { entityId, room, status } };
  },

  reduce: (ctx) => {
    if (ctx.status !== 'Valve Characteristic Lost') {
      return {
        decision: 'no_action',
        reason: `status_not_critical:${ctx.status}`,
        inputs: ctx.inputs,
        actions: [],
      };
    }

    const title = 'Heating - TRV Adaptation';
    const message = `${ctx.room} TRV lost valve characteristic - adaptation run needed`;

    return {
      decision: 'notify',
      reason: `valve_characteristic_lost:${ctx.room}`,
      inputs: ctx.inputs,
      actions: [
        { type: 'ha.call_service', domain: 'notify', service: 'mobile_app_adams_iphone', data: { title, message } },
        { type: 'ha.call_service', domain: 'notify', service: 'mobile_app_sarahs_iphone', data: { title, message } },
      ],
    };
  },
});
