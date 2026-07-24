import { defineAutomation, type Action, type Trigger } from '@ajclarkson/homerun';

export interface OccupancyRoomConfig {
  location: string;
  delayMins?: number;
  containmentMaxMins?: number;
  reopenTightenMins?: number;
  /** Extra state_changed triggers for door contacts or other hold entities specific to this room. */
  extraTriggers?: Trigger[];
}

type OccupancyTrigger =
  | { type: 'motion'; to: 'on' | 'off' }
  | { type: 'state_change'; entity: string; to: string }
  | { type: 'timer' }
  | { type: 'system' };

interface OccupancyContext {
  location: string;
  trigger: OccupancyTrigger;
  motionEnabled: boolean;
  pirRaw: boolean;
  motionActive: boolean;
  pirTriggered: boolean;
  strongHoldActive: boolean;
  evidenceNow: boolean;
  isDoorMsg: boolean;
  sealedNow: boolean;
  occupiedBefore: boolean;
  containedBefore: boolean;
  sourceEntity: string | null;
  sourceValue: string | null;
}

export function makeOccupancyAutomation(config: OccupancyRoomConfig) {
  const {
    location,
    delayMins = 5,
    containmentMaxMins = 720,
    reopenTightenMins = 2,
  } = config;

  const timerKey = `${location}:occupied_clear`;
  const motionSensor = `binary_sensor.${location}_sensor_motion_occupancy`;
  const motionGate = `input_boolean.${location}_sensor_motion_enabled`;
  const presenceOverride = `input_boolean.${location}_automation_presence_override`;
  const occupiedTopic = `${location}/occupied/state`;
  const occupiedEntity = `binary_sensor.${location}_occupied`;
  const containedTopic = `${location}/occupied/contained/state`;
  const containedEntity = `binary_sensor.${location}_occupied_contained`;

  const delayMs = delayMins * 60_000;
  const containmentMaxMs = containmentMaxMins * 60_000;
  const reopenTightenMs = reopenTightenMins * 60_000;

  return defineAutomation<OccupancyContext>({
    id: `${location}:occupancy`,
    location,
    subsystem: 'occupied',

    triggers: [
      { type: 'state_changed', entity: motionSensor as keyof HAEntities },
      { type: 'state_changed', entity: motionGate as keyof HAEntities },
      { type: 'state_changed', entity: presenceOverride as keyof HAEntities },
      ...(config.extraTriggers ?? []),
      { type: 'timer_expired', timerKey },
      { type: 'on_start' },
    ],

    context: (state, ha, event) => {
      let trigger: OccupancyTrigger;
      if (event.type === 'timer_expired') {
        trigger = { type: 'timer' };
      } else if (event.type === 'state_changed' && event.entity_id === motionSensor) {
        trigger = { type: 'motion', to: event.new_state.state === 'on' ? 'on' : 'off' };
      } else if (event.type === 'state_changed') {
        trigger = { type: 'state_change', entity: event.entity_id, to: event.new_state.state };
      } else {
        trigger = { type: 'system' };
      }

      const sourceEntity = event.type === 'state_changed' ? event.entity_id : null;
      const sourceValue = event.type === 'state_changed' ? event.new_state.state : null;

      // Prefer event payload over cached HA state for the triggered entity
      const readState = (entityId: string): string | undefined => {
        if (sourceEntity === entityId) return sourceValue ?? state(entityId as keyof HAEntities)?.state;
        return state(entityId as keyof HAEntities)?.state;
      };

      // Discover hold entities via HA labels, filtered to this room's area
      const areaEntities = ha.entitiesByArea(location);
      const strongHoldEntities = ha.entitiesByLabel('presence_hold_strong').filter(e => areaEntities.includes(e));
      const doorEntities = ha.entitiesByLabel('presence_hold_door').filter(e => areaEntities.includes(e));

      const motionEnabled = readState(motionGate) === 'on';
      const pirRaw = readState(motionSensor) === 'on';
      const motionActive = motionEnabled && pirRaw;
      const pirTriggered = sourceEntity === motionSensor && sourceValue === 'on';

      const strongHoldActive = strongHoldEntities.some(e => {
        const override = ha.labelsFor(e).find(l => l.startsWith('presence_hold_state_'));
        const holdState = override ? override.slice('presence_hold_state_'.length) : 'on';
        return readState(e) === holdState;
      });

      const isDoorMsg = doorEntities.some(e => e === sourceEntity);
      const sealedNow =
        doorEntities.length > 0 &&
        doorEntities.every(e => readState(e) === 'off');

      const occupiedBefore = state(`binary_sensor.${location}_occupied` as keyof HAEntities)?.state === 'on';
      const containedBefore = state(`binary_sensor.${location}_occupied_contained` as keyof HAEntities)?.state === 'on';
      const evidenceNow = strongHoldActive || motionActive;

      return {
        location, trigger,
        motionEnabled, pirRaw, motionActive, pirTriggered,
        strongHoldActive, evidenceNow, isDoorMsg, sealedNow,
        occupiedBefore, containedBefore,
        sourceEntity, sourceValue,
      };
    },

    reduce: (ctx) => {
      const {
        trigger, motionEnabled, pirRaw, motionActive, pirTriggered,
        strongHoldActive, evidenceNow, isDoorMsg, sealedNow,
        occupiedBefore, containedBefore,
        sourceValue,
      } = ctx;

      const actions: Action[] = [];
      const publish = (topic: string, payload: string, impliesEntity: string) =>
        actions.push({ type: 'mqtt.publish', topic, payload, retain: true, impliesEntity });
      const timerStart = (ms: number) =>
        actions.push({ type: 'timer.start', timerKey, delayMs: ms });
      const timerCancel = () =>
        actions.push({ type: 'timer.cancel', timerKey });

      // Compute containedNext: mirrors Node-RED pre-branch containment mutations
      let containedNext = containedBefore;
      if (!motionEnabled) containedNext = false;
      if (!occupiedBefore || !sealedNow) containedNext = false;
      if (pirTriggered && sealedNow && motionEnabled) containedNext = true;
      if (isDoorMsg && sourceValue === 'on') containedNext = false;

      const publishContainedIfChanged = () => {
        if (containedNext !== containedBefore) publish(containedTopic, containedNext ? 'ON' : 'OFF', containedEntity);
      };

      const isTimer = trigger.type === 'timer';

      // Branch 0: PIR fired while motion gate is off — complete no-op, don't touch timers.
      // The gate means "ignore PIR entirely"; the existing clear timer should keep ticking.
      if (pirTriggered && !motionEnabled) {
        publishContainedIfChanged();
        return { decision: 'no_change', reason: 'motion_disabled_ignore_pir', actions };
      }

      // Branch 1: Evidence present — set occupied, cancel any pending clear timer
      if (evidenceNow) {
        if (!occupiedBefore) publish(occupiedTopic, 'ON', occupiedEntity);
        publishContainedIfChanged();
        timerCancel();
        return {
          decision: occupiedBefore ? 'no_change' : 'set_occupied',
          reason: strongHoldActive ? 'strong_hold_active' : 'motion_detected',
          actions,
        };
      }

      // Branch 2: Clear timer fired — mark unoccupied
      if (isTimer) {
        if (occupiedBefore) publish(occupiedTopic, 'OFF', occupiedEntity);
        // Explicitly clear containment regardless of computed containedNext,
        // because the timer expiry always terminates containment
        if (containedBefore) publish(containedTopic, 'OFF', containedEntity);
        return {
          decision: occupiedBefore ? 'clear_occupied' : 'no_change',
          reason: containedBefore ? 'containment_failsafe_expired' : 'timer_expired',
          actions,
        };
      }

      // Branch 3: No evidence, still occupied — start or tighten clear timer
      if (occupiedBefore) {
        publishContainedIfChanged();
        if (isDoorMsg && sourceValue === 'on' && !strongHoldActive && !pirRaw) {
          timerStart(reopenTightenMs);
          return { decision: 'no_change', reason: 'door_open_tighten_timer', actions };
        }
        if (containedNext && sealedNow) {
          timerStart(containmentMaxMs);
          return { decision: 'no_change', reason: 'contained_failsafe_wait', actions };
        }
        timerStart(delayMs);
        return { decision: 'no_change', reason: 'normal_clear_timer', actions };
      }

      // Branch 4: No evidence, already unoccupied — idempotent timer cancel
      timerCancel();
      return { decision: 'no_change', reason: 'already_unoccupied', actions };
    },
  });
}
