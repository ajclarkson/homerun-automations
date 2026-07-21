import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAutomation, testAbort } from '@ajclarkson/homerun/testing';
import automation from './mo-frigate.js';

const NOW = new Date('2026-07-21T14:00:00.000Z');
const RECENT = new Date(NOW.getTime() - 2 * 60 * 1000).toISOString();  // 2 min ago — within cooldown
const STALE  = new Date(NOW.getTime() - 10 * 60 * 1000).toISOString(); // 10 min ago — past cooldown

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
afterEach(() => vi.useRealTimers());

function mqttEvent(payload: object) {
  return {
    type: 'mqtt_in' as const,
    topic: 'frigate/events',
    payload: JSON.stringify(payload),
    correlation_id: 'test-cid',
  };
}

const spottedPayload = {
  type: 'new',
  after: { label: 'cat', camera: 'kitchen', entered_zones: [], id: 'evt-1' },
  before: { entered_zones: [] },
};

const eatingPayload = {
  type: 'update',
  after: { label: 'cat', camera: 'kitchen', entered_zones: ['feeder'], id: 'evt-2' },
  before: { entered_zones: [] },
};

const existingTimeline = {
  eating:  [{ room: 'Parlour', camera: 'parlour', ts: NOW.getTime() - 3600000, event_id: 'old-1' }],
  spotted: [{ room: 'Parlour', camera: 'parlour', ts: NOW.getTime() - 7200000, event_id: 'old-2' }],
};

const baseState = {
  'input_boolean.mo_notifications_eating_enabled':  { state: 'on' },
  'input_boolean.mo_notifications_spotted_enabled': { state: 'on' },
  'input_text.mo_cooldown_eating':                  { state: STALE },
  'input_text.mo_cooldown_spotted_parlour':         { state: STALE },
  'input_text.mo_cooldown_spotted_kitchen':         { state: STALE },
  'input_text.mo_cooldown_spotted_home_office':     { state: STALE },
  'sensor.mo_timeline': { state: 'Mo spotted · Parlour', attributes: existingTimeline },
};

function run(payload: object, override: Record<string, unknown> = {}) {
  return testAutomation(automation, { event: mqttEvent(payload), state: { ...baseState, ...override } });
}

// ─── event classification ─────────────────────────────────────────────────────

describe('event classification', () => {
  it('classifies feeder zone entry as eating', () => {
    const result = run(eatingPayload);
    expect(result.decision).toBe('notify');
    expect(result.reason).toBe('eating');
  });

  it('classifies type:new without feeder as spotted', () => {
    const result = run(spottedPayload);
    expect(result.reason).toBe('spotted');
  });

  it('takes no action for type:update without feeder entry (routine Frigate noise)', () => {
    const result = testAutomation(automation, {
      event: mqttEvent({ type: 'update', after: { label: 'cat', camera: 'kitchen', entered_zones: [], id: 'e' }, before: { entered_zones: [] } }),
      state: baseState,
    });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('not_actionable');
  });

  it('takes no action when label is not cat', () => {
    const result = testAutomation(automation, {
      event: mqttEvent({ ...spottedPayload, after: { ...spottedPayload.after, label: 'person' } }),
      state: baseState,
    });
    expect(result.decision).toBe('no_action');
    expect((result.inputs as { filterReason?: string })?.filterReason).toBe('not_a_cat_event');
  });

  it('aborts for unknown camera', () => {
    const result = testAbort(automation, {
      event: mqttEvent({ ...spottedPayload, after: { ...spottedPayload.after, camera: 'garage' } }),
      state: baseState,
    });
    expect(result.reason).toMatch(/unknown_camera/);
  });

  it('aborts for invalid JSON payload', () => {
    const result = testAbort(automation, {
      event: { type: 'mqtt_in' as const, topic: 'frigate/events', payload: 'not-json', correlation_id: 'x' },
      state: baseState,
    });
    expect(result.reason).toBe('invalid_json');
  });
});

// ─── timeline update ──────────────────────────────────────────────────────────

describe('timeline update', () => {
  it('prepends eating entry and caps at 20', () => {
    const fullEating = Array.from({ length: 20 }, (_, i) => ({
      room: 'Kitchen', camera: 'kitchen', ts: NOW.getTime() - i * 1000, event_id: `e${i}`,
    }));
    const result = run(eatingPayload, {
      'sensor.mo_timeline': { state: 'Mo eating · Kitchen', attributes: { eating: fullEating, spotted: [] } },
    });
    const mqtt = result.actions.find((a: unknown) => (a as { type: string }).type === 'mqtt.publish') as { payload: string } | undefined;
    const published = JSON.parse(mqtt!.payload);
    expect(published.eating).toHaveLength(20);
    expect(published.eating[0].camera).toBe('kitchen');
    expect(published.eating[0].ts).toBe(NOW.getTime());
  });

  it('prepends spotted entry and caps at 10', () => {
    const fullSpotted = Array.from({ length: 10 }, (_, i) => ({
      room: 'Parlour', camera: 'parlour', ts: NOW.getTime() - i * 1000, event_id: `s${i}`,
    }));
    const result = run(spottedPayload, {
      'sensor.mo_timeline': { state: 'Mo spotted · Parlour', attributes: { eating: [], spotted: fullSpotted } },
    });
    const mqtt = result.actions.find((a: unknown) => (a as { type: string }).type === 'mqtt.publish') as { payload: string } | undefined;
    const published = JSON.parse(mqtt!.payload);
    expect(published.spotted).toHaveLength(10);
    expect(published.spotted[0].camera).toBe('kitchen');
  });

  it('publishes with retain: true', () => {
    const result = run(spottedPayload);
    const mqtt = result.actions.find((a: unknown) => (a as { type: string }).type === 'mqtt.publish') as { retain: boolean } | undefined;
    expect(mqtt?.retain).toBe(true);
  });

  it('handles empty timeline on first run', () => {
    const result = run(eatingPayload, {
      'sensor.mo_timeline': { state: '', attributes: {} },
    });
    const mqtt = result.actions.find((a: unknown) => (a as { type: string }).type === 'mqtt.publish') as { payload: string } | undefined;
    const published = JSON.parse(mqtt!.payload);
    expect(published.eating).toHaveLength(1);
  });
});

// ─── cooldown ─────────────────────────────────────────────────────────────────

describe('cooldown', () => {
  it('suppresses eating notification within cooldown window', () => {
    const result = run(eatingPayload, { 'input_text.mo_cooldown_eating': { state: RECENT } });
    expect(result.decision).toBe('no_action');
    expect(result.reason).toBe('cooldown_active');
  });

  it('suppresses spotted notification within cooldown window for that camera', () => {
    const result = run(spottedPayload, { 'input_text.mo_cooldown_spotted_kitchen': { state: RECENT } });
    expect(result.decision).toBe('no_action');
  });

  it('does not suppress when cooldown has expired', () => {
    const result = run(spottedPayload, { 'input_text.mo_cooldown_spotted_kitchen': { state: STALE } });
    expect(result.decision).toBe('notify');
  });

  it('uses per-camera cooldown for spotted — different cameras independent', () => {
    // Kitchen cooldown active, but parlour is not
    const parlourSpotted = { ...spottedPayload, after: { ...spottedPayload.after, camera: 'parlour' } };
    const result = run(parlourSpotted, { 'input_text.mo_cooldown_spotted_kitchen': { state: RECENT } });
    expect(result.decision).toBe('notify');
  });

  it('records cooldown timestamp on eating notification', () => {
    const result = run(eatingPayload);
    expect(result.actions).toContainEqual(expect.objectContaining({
      domain: 'input_text',
      target: { entity_id: 'input_text.mo_cooldown_eating' },
    }));
  });

  it('records cooldown timestamp on spotted notification for correct camera', () => {
    const result = run(spottedPayload);
    expect(result.actions).toContainEqual(expect.objectContaining({
      domain: 'input_text',
      target: { entity_id: 'input_text.mo_cooldown_spotted_kitchen' },
    }));
  });
});

// ─── notification gates ───────────────────────────────────────────────────────

describe('notification gates', () => {
  it('still updates timeline when eating notifications are disabled', () => {
    const result = run(eatingPayload, { 'input_boolean.mo_notifications_eating_enabled': { state: 'off' } });
    expect(result.decision).toBe('notify');
    const notifyActions = result.actions.filter((a: unknown) => (a as { domain?: string }).domain === 'notify');
    expect(notifyActions).toHaveLength(0);
    const mqttAction = result.actions.find((a: unknown) => (a as { type: string }).type === 'mqtt.publish');
    expect(mqttAction).toBeDefined();
  });

  it('still updates timeline when spotted notifications are disabled', () => {
    const result = run(spottedPayload, { 'input_boolean.mo_notifications_spotted_enabled': { state: 'off' } });
    expect(result.decision).toBe('notify');
    const notifyActions = result.actions.filter((a: unknown) => (a as { domain?: string }).domain === 'notify');
    expect(notifyActions).toHaveLength(0);
  });

  it('notifies both adam and sarah when enabled', () => {
    const result = run(eatingPayload);
    const notifyActions = result.actions.filter((a: unknown) => (a as { domain?: string }).domain === 'notify');
    expect(notifyActions).toHaveLength(2);
  });

  it('notification includes image and camera URL', () => {
    const result = run(eatingPayload);
    const notify = result.actions.find((a: unknown) => (a as { domain?: string }).domain === 'notify') as
      { data: { data: { image: string; url: string } } } | undefined;
    expect(notify?.data.data.image).toMatch(/image_proxy/);
    expect(notify?.data.data.url).toBe('/mobile-dashboard/cameras');
  });
});
