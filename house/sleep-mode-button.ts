import { defineAutomation, abort } from '@ajclarkson/homerun';

const INACTIVE_STATES = new Set(['off', 'idle', 'unavailable', 'unknown']);
const isActive = (state: string | undefined) => !!state && !INACTIVE_STATES.has(state);

const TV_SOURCE_STALE_MS = 2 * 60 * 1000;

export default defineAutomation({
  id: 'house:sleep_mode_button',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'button', entity: /^sensor\.bedroom_button_.*_action$/, gesture: 'hold' },
  ],

  context: (state) => {
    const bedOccupied = state('binary_sensor.bedroom_sensor_bed_occupancy')?.state;
    if (!bedOccupied || bedOccupied === 'unavailable' || bedOccupied === 'unknown') {
      return abort(`bed_sensor_unavailable:${bedOccupied}`);
    }

    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode || houseMode === 'unavailable' || houseMode === 'unknown') {
      return abort(`house_mode_unavailable:${houseMode}`);
    }

    const parlourSonosEntity = state('media_player.parlour');
    const parlourTvEntity = state('media_player.parlour_tv');
    const parlourSonos = parlourSonosEntity?.state;
    const parlourTv = parlourTvEntity?.state;
    const sonosSource = parlourSonosEntity?.attributes?.source as string | undefined;

    const tvOff = !isActive(parlourTv);
    const tvOffMs = tvOff
      ? Date.now() - Date.parse(parlourTvEntity?.last_changed ?? '')
      : 0;
    const sonosStale = isActive(parlourSonos) && sonosSource === 'TV' && tvOff && tvOffMs > TV_SOURCE_STALE_MS;
    const parlourActive = (isActive(parlourSonos) && !sonosStale) || isActive(parlourTv);

    return {
      bedOccupied: bedOccupied === 'on',
      houseMode,
      parlourActive,
      inputs: { bedOccupied, houseMode, parlourSonos, parlourTv, sonosSource, tvOffMs: Math.round(tvOffMs / 1000) },
    };
  },

  reduce: (ctx) => {
    if (!ctx.bedOccupied) {
      return { decision: 'no_action', reason: 'bed_not_occupied', inputs: ctx.inputs, actions: [] };
    }
    if (ctx.parlourActive) {
      return { decision: 'no_action', reason: 'parlour_active', inputs: ctx.inputs, actions: [] };
    }
    if (ctx.houseMode === 'sleep') {
      return { decision: 'no_action', reason: 'already_in_sleep_mode', inputs: ctx.inputs, actions: [] };
    }
    return {
      decision: 'set_sleep',
      reason: 'button_hold_bed_occupied',
      inputs: ctx.inputs,
      actions: [
        { type: 'mqtt.publish', topic: 'house/mode/active', payload: 'sleep' },
      ],
    };
  },
});
