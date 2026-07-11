import { defineAutomation, abort } from '@ajclarkson/homerun';

const DOOR_WINDOW_MS = 15 * 60 * 1000;

export default defineAutomation({
  id: 'house:away_detection',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'state_changed', entity: 'zone.home' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const zoneHome = state('zone.home');
    const personCount = parseInt(zoneHome?.state ?? '', 10);
    if (!Number.isFinite(personCount)) {
      return abort(`zone_home_unavailable:${zoneHome?.state}`);
    }

    const houseMode = state('sensor.house_active_mode')?.state;
    if (!houseMode) {
      return abort('house_mode_unavailable');
    }

    const doorsEntity = state('binary_sensor.external_doors_state');
    if (!doorsEntity) {
      return abort('doors_entity_missing');
    }

    const doorsLastChangedMs = Date.parse(doorsEntity.last_changed);
    const timeSinceDoorsChangedMs = Number.isFinite(doorsLastChangedMs)
      ? Date.now() - doorsLastChangedMs
      : Infinity;

    const noneHome = personCount === 0;
    const doorRecentlyChanged = timeSinceDoorsChangedMs <= DOOR_WINDOW_MS;

    return {
      noneHome,
      doorRecentlyChanged,
      houseMode,
      inputs: {
        personCount,
        noneHome,
        houseMode,
        timeSinceDoorsChangedMs,
        doorRecentlyChanged,
      },
    };
  },

  reduce: (ctx) => {
    const { noneHome, doorRecentlyChanged, houseMode } = ctx;
    const actions: { type: 'mqtt.publish'; topic: string; payload: string }[] = [];
    let decision: string;
    let reason: string;

    if (noneHome && doorRecentlyChanged) {
      decision = 'set_away';
      reason = 'all_left_door_recently';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away' });
    } else if (!noneHome && houseMode === 'away') {
      decision = 'set_normal';
      reason = 'someone_returned';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal' });
    } else if (noneHome) {
      decision = 'no_action';
      reason = 'no_door_event';
    } else {
      decision = 'no_action';
      reason = 'not_in_away_mode';
    }

    return {
      decision,
      reason,
      inputs: ctx.inputs,
      actions,
    };
  },
});
