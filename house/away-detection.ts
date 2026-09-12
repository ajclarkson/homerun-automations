import { defineAutomation, abort } from '@ajclarkson/homerun';
import type { TriggerEvent } from '@ajclarkson/homerun';

const DOOR_WINDOW_MS = 15 * 60 * 1000;
const MODIFIER_ENTITY = 'input_select.house_active_mode_modifier';

export default defineAutomation({
  id: 'house:away_detection',
  location: 'house',
  subsystem: 'house_mode',

  triggers: [
    { type: 'state_changed', entity: 'zone.home' },
    { type: 'state_changed', entity: MODIFIER_ENTITY },
    { type: 'on_start' },
  ],

  context: (state, _ha, event: TriggerEvent) => {
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

    const modifier = state(MODIFIER_ENTITY)?.state;
    if (!modifier || modifier === 'unavailable' || modifier === 'unknown') {
      return abort(`modifier_unavailable:${modifier}`);
    }

    const doorsLastChangedMs = Date.parse(doorsEntity.last_changed);
    const timeSinceDoorsChangedMs = Number.isFinite(doorsLastChangedMs)
      ? Date.now() - doorsLastChangedMs
      : Infinity;

    const noneHome = personCount === 0;
    const doorRecentlyChanged = timeSinceDoorsChangedMs <= DOOR_WINDOW_MS;
    const sitterActive = modifier === 'sitter';

    const sitterJustLeft = event.type === 'state_changed'
      && event.entity_id === MODIFIER_ENTITY
      && event.old_state?.state === 'sitter'
      && modifier !== 'sitter';

    return {
      noneHome,
      doorRecentlyChanged,
      houseMode,
      sitterActive,
      sitterJustLeft,
    };
  },

  reduce: (ctx) => {
    const { noneHome, doorRecentlyChanged, houseMode, sitterActive, sitterJustLeft } = ctx;
    const actions: { type: 'mqtt.publish'; topic: string; payload: string; impliesEntity?: string }[] = [];
    let decision = 'uninitialised';
    let reason = 'uninitialised';

    if (sitterActive && houseMode === 'away') {
      decision = 'set_normal';
      reason = 'sitter_present';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' });
    } else if (sitterActive) {
      decision = 'no_action';
      reason = 'sitter_present';
    } else if (noneHome && sitterJustLeft && houseMode !== 'away') {
      decision = 'set_away';
      reason = 'sitter_mode_ended_house_empty';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' });
    } else if (noneHome && doorRecentlyChanged) {
      decision = 'set_away';
      reason = 'all_left_door_recently';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'away', impliesEntity: 'sensor.house_active_mode' });
    } else if (!noneHome && houseMode === 'away') {
      decision = 'set_normal';
      reason = 'someone_returned';
      actions.push({ type: 'mqtt.publish', topic: 'house/mode/active', payload: 'normal', impliesEntity: 'sensor.house_active_mode' });
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
      actions,
    };
  },
});
