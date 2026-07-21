import { defineAutomation, abort, type Action } from '@ajclarkson/homerun';

const COOLDOWN_MS = 5 * 60 * 1000;
const TIMELINE_TOPIC = 'homeassistant/sensor/mo_timeline';

const CAMERA_MAP: Record<string, { room: string; image: string; spottedCooldownEntity: string }> = {
  parlour:     { room: 'Parlour',     image: 'image.parlour_cat',     spottedCooldownEntity: 'input_text.mo_cooldown_spotted_parlour'     },
  kitchen:     { room: 'Kitchen',     image: 'image.kitchen_cat',     spottedCooldownEntity: 'input_text.mo_cooldown_spotted_kitchen'     },
  home_office: { room: 'Home Office', image: 'image.home_office_cat', spottedCooldownEntity: 'input_text.mo_cooldown_spotted_home_office' },
};

interface FrigateEvent {
  type: string;
  after: {
    label: string;
    camera: string;
    entered_zones: string[];
    id: string;
  };
  before?: {
    entered_zones: string[];
  };
}

interface TimelineEntry {
  room: string;
  camera: string;
  ts: number;
  event_id: string;
}

function isCooldownActive(lastSent: string | undefined, now: number): boolean {
  if (!lastSent) return false;
  const t = new Date(lastSent).getTime();
  return Number.isFinite(t) && now - t < COOLDOWN_MS;
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

function notifyAction(service: string, title: string, message: string, image: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    target: { entity_id: `notify.${service}` },
    data: { title, message, data: { image: `/api/image_proxy/${image}`, url: '/mobile-dashboard/cameras' } },
  };
}

export default defineAutomation({
  id: 'house:mo_frigate',
  location: 'house',
  subsystem: 'mo',

  triggers: [
    { type: 'mqtt_in', topic: 'frigate/events' },
  ],

  context: (state, _ha, event) => {
    if (event.type !== 'mqtt_in') return abort('unexpected_trigger');

    let payload: FrigateEvent;
    try {
      payload = JSON.parse(event.payload) as FrigateEvent;
    } catch {
      return abort('invalid_json');
    }

    const noAction = (reason: string) => ({
      eventType: null as null,
      camera: '', cam: CAMERA_MAP['kitchen'], now: 0,
      cooldownActive: false, eatingEnabled: false, spottedEnabled: false,
      existingEating: [] as TimelineEntry[], existingSpotted: [] as TimelineEntry[], eventId: '',
      inputs: { eventType: null, camera: '', room: '', cooldownActive: false, eatingEnabled: false, spottedEnabled: false, filterReason: reason },
    });

    if (payload.after?.label !== 'cat') return noAction('not_a_cat_event');

    const camera = payload.after.camera;
    const cam = CAMERA_MAP[camera];
    if (!cam) return abort(`unknown_camera:${camera}`);

    const afterZones  = payload.after.entered_zones  ?? [];
    const beforeZones = payload.before?.entered_zones ?? [];
    const justEnteredFeeder = afterZones.includes('feeder') && !beforeZones.includes('feeder');
    const isNewDetection    = payload.type === 'new';

    const eventType = justEnteredFeeder ? 'eating'
      : (isNewDetection ? 'spotted' : null);

    const now = Date.now();

    if (!eventType) return noAction('not_actionable');

    const eatingCooldownActive   = isCooldownActive(state('input_text.mo_cooldown_eating')?.state, now);
    const spottedCooldownActive  = isCooldownActive(state(cam.spottedCooldownEntity as Parameters<typeof state>[0])?.state, now);
    const cooldownActive = eventType === 'eating' ? eatingCooldownActive : spottedCooldownActive;

    const eatingEnabled  = state('input_boolean.mo_notifications_eating_enabled')?.state === 'on';
    const spottedEnabled = state('input_boolean.mo_notifications_spotted_enabled')?.state === 'on';

    const timeline = state('sensor.mo_timeline');
    const existingEating  = (timeline?.attributes?.['eating']  as TimelineEntry[] | undefined) ?? [];
    const existingSpotted = (timeline?.attributes?.['spotted'] as TimelineEntry[] | undefined) ?? [];

    return {
      eventType,
      camera,
      cam,
      now,
      cooldownActive,
      eatingEnabled,
      spottedEnabled,
      existingEating,
      existingSpotted,
      eventId: payload.after.id,
      inputs: { eventType, camera, room: cam.room, cooldownActive, eatingEnabled, spottedEnabled },
    };
  },

  reduce: (ctx) => {
    const {
      eventType, camera, cam, now, cooldownActive,
      eatingEnabled, spottedEnabled,
      existingEating, existingSpotted, eventId,
    } = ctx;

    if (!eventType) {
      return { decision: 'no_action', reason: 'not_actionable', inputs: ctx.inputs, actions: [] };
    }

    if (cooldownActive) {
      return { decision: 'no_action', reason: 'cooldown_active', inputs: ctx.inputs, actions: [] };
    }

    const entry: TimelineEntry = { room: cam.room, camera, ts: now, event_id: eventId };
    const nowIso = new Date(now).toISOString();

    let updatedEating  = existingEating;
    let updatedSpotted = existingSpotted;
    let stateStr: string;
    let cooldownEntity: string;
    let notificationsEnabled: boolean;
    let notifyTitle: string;

    if (eventType === 'eating') {
      updatedEating = [entry, ...existingEating].slice(0, 20);
      stateStr = `Mo eating · ${cam.room}`;
      cooldownEntity = 'input_text.mo_cooldown_eating';
      notificationsEnabled = eatingEnabled;
      notifyTitle = 'Mo is eating';
    } else {
      updatedSpotted = [entry, ...existingSpotted].slice(0, 10);
      stateStr = `Mo spotted · ${cam.room}`;
      cooldownEntity = cam.spottedCooldownEntity;
      notificationsEnabled = spottedEnabled;
      notifyTitle = 'Mo spotted';
    }

    const timelinePayload = JSON.stringify({ state: stateStr, eating: updatedEating, spotted: updatedSpotted });

    const actions: Action[] = [
      setInputText(cooldownEntity, nowIso),
      { type: 'mqtt.publish' as const, topic: TIMELINE_TOPIC, payload: timelinePayload, retain: true },
    ];

    if (notificationsEnabled) {
      actions.push(
        notifyAction('mobile_app_adams_iphone',  notifyTitle, cam.room, cam.image),
        notifyAction('mobile_app_sarahs_iphone', notifyTitle, cam.room, cam.image),
      );
    }

    return {
      decision: 'notify',
      reason: eventType,
      inputs: ctx.inputs,
      actions,
    };
  },
});
