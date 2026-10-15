import { defineAutomation, abort } from '@ajclarkson/homerun';

const POWER_DOWN_EVENTS = 'event.octopus_energy_a_644e00d3_octoplus_power_down_events';

interface AvailableEvent {
  code: string;
  start: string;
  end: string;
  octopoints_per_kwh?: number;
}

function isAvailableEvent(e: unknown): e is AvailableEvent {
  if (typeof e !== 'object' || e === null) return false;
  const { code, start, end } = e as Record<string, unknown>;
  return typeof code === 'string' && typeof start === 'string' && typeof end === 'string';
}

function joinAction(event: AvailableEvent) {
  return {
    type: 'ha.call_service' as const,
    domain: 'octopus_energy',
    service: 'join_octoplus_power_down_session_event',
    target: { entity_id: POWER_DOWN_EVENTS },
    data: { event_code: event.code },
  };
}

function notifyAction(service: string, message: string) {
  return {
    type: 'ha.call_service' as const,
    domain: 'notify',
    service,
    data: { title: '⚡ Joined power down session', message, data: { url: '/mobile-dashboard/energy' } },
  };
}

function describeSession(event: AvailableEvent): string {
  const tz = 'Europe/London';
  const day = new Date(event.start).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: tz });
  const time = (iso: string) => new Date(iso).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  const reward = event.octopoints_per_kwh !== undefined ? ` · ${event.octopoints_per_kwh} octopoints/kWh` : '';
  return `${day} ${time(event.start)}–${time(event.end)}${reward}`;
}

// Joins every power down session (formerly "saving sessions") as soon as Octopus announces it.
// `available_events` only lists sessions not yet joined, so a joined session drops out of it and
// is never re-joined. The schedule and on_start triggers catch anything missed while offline.
export default defineAutomation({
  id: 'house:octopus_power_down_auto_join',
  location: 'house',
  subsystem: 'energy',

  triggers: [
    { type: 'state_changed', entity: POWER_DOWN_EVENTS },
    { type: 'schedule', cron: '0 * * * *' },
    { type: 'on_start' },
  ],

  context: (state) => {
    const raw = state(POWER_DOWN_EVENTS)?.attributes?.['available_events'];
    const available = Array.isArray(raw) ? raw.filter(isAvailableEvent) : [];

    if (available.length === 0) return abort('no_sessions_to_join');

    return { available };
  },

  reduce: (ctx) => {
    const { available } = ctx;

    const notifications = available.flatMap((event) => {
      const message = describeSession(event);
      return [
        notifyAction('mobile_app_adams_iphone', message),
        notifyAction('mobile_app_sarahs_iphone', message),
      ];
    });

    return {
      decision: 'join',
      reason: `${available.length}_available`,
      actions: [...available.map(joinAction), ...notifications],
    };
  },
});
