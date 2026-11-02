import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { testAbort } from '@ajclarkson/homerun/testing';
import { testDeclared as testAutomation } from './declared-outcome.js';
import type { HAContext } from '@ajclarkson/homerun';
import { makeOutdoorLightingAutomation } from './outdoor-lighting-factory.js';

const LOCATION = 'test_garden';
const ON_SCENE = `scene.${LOCATION}_all`;
const OFF_SCENE = `scene.${LOCATION}_off`;
const AUTUMN_SCENE = `scene.${LOCATION}_autumn`;
const THEME = `input_select.${LOCATION}_light_theme`;

const automation = makeOutdoorLightingAutomation({ location: LOCATION });
const midnightAutomation = makeOutdoorLightingAutomation({ location: LOCATION, offTime: '00:00' });

// On scene carries scene_order_1, off scene carries scene_control_off, and an autumn theme scene
// carries scene_theme_autumn — all in this area. No halloween scene exists yet.
// Another area's scenes carry the same labels, to prove discovery is area-scoped.
function makeHa(opts: { omit?: 'on' | 'off' } = {}): Partial<HAContext> {
  const area = [
    ...(opts.omit === 'on' ? [] : [ON_SCENE]),
    ...(opts.omit === 'off' ? [] : [OFF_SCENE]),
    AUTUMN_SCENE,
  ];
  const otherArea = ['scene.other_garden_all', 'scene.other_garden_off', 'scene.other_garden_autumn', 'scene.other_garden_halloween'];
  const labelMap: Record<string, string[]> = {
    scene_order_1: ['scene.other_garden_all', ON_SCENE],
    scene_control_off: ['scene.other_garden_off', OFF_SCENE],
    scene_theme_autumn: ['scene.other_garden_autumn', AUTUMN_SCENE],
    scene_theme_halloween: ['scene.other_garden_halloween'],
  };
  return {
    entitiesByArea: (a) => (a === LOCATION ? area : otherArea),
    entitiesByLabel: (label) => labelMap[label] ?? [],
  };
}

const baseState = {
  [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'on' },
  'sun.sun': { state: 'above_horizon' },
  'sensor.house_active_mode': { state: 'normal' },
  [THEME]: { state: 'normal' },
};

function sunEvent(to: 'below_horizon' | 'above_horizon') {
  const from = to === 'below_horizon' ? 'above_horizon' : 'below_horizon';
  return {
    type: 'state_changed' as const,
    entity_id: 'sun.sun',
    old_state: { entity_id: 'sun.sun', state: from, attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: 'sun.sun', state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

const sunsetEvent = sunEvent('below_horizon');
const sunriseEvent = sunEvent('above_horizon');
const scheduleOffEvent = { type: 'schedule' as const, cron: '0 22 * * *', correlation_id: 'test-cid' };
const onStartEvent = { type: 'on_start' as const, correlation_id: 'test-cid' };

function houseModeEvent(to: string) {
  return {
    type: 'state_changed' as const,
    entity_id: 'sensor.house_active_mode',
    old_state: { entity_id: 'sensor.house_active_mode', state: 'normal', attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: 'sensor.house_active_mode', state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

function themeEvent(to: string) {
  return {
    type: 'state_changed' as const,
    entity_id: THEME,
    old_state: { entity_id: THEME, state: 'normal', attributes: {}, last_changed: '', last_updated: '' },
    new_state: { entity_id: THEME, state: to, attributes: {}, last_changed: '', last_updated: '' },
    correlation_id: 'test-cid',
  };
}

type AnyEvent = typeof sunsetEvent | typeof scheduleOffEvent | typeof onStartEvent | ReturnType<typeof houseModeEvent> | ReturnType<typeof themeEvent>;

function run(event: AnyEvent, overrideState: Record<string, { state: string }> = {}) {
  return testAutomation(automation, { event, state: { ...baseState, ...overrideState }, ha: makeHa() });
}

function runMidnight(event: AnyEvent, overrideState: Record<string, { state: string }> = {}) {
  return testAutomation(midnightAutomation, { event, state: { ...baseState, ...overrideState }, ha: makeHa() });
}

// The test clock is set in local wall-clock time, matching how the automation reads the hour,
// so these tests pass whatever timezone they run in.
const clockAt = (day: number, time: string) => {
  const [h, m] = time.split(':').map(Number);
  vi.setSystemTime(new Date(2026, 0, day, h, m));
};
const at = (time: string) => clockAt(7, time);
const nextDayAt = (time: string) => clockAt(8, time);

const dark = { 'sun.sun': { state: 'below_horizon' } };
const light = { 'sun.sun': { state: 'above_horizon' } };
const disabled = { [`input_boolean.${LOCATION}_automation_lights_enabled`]: { state: 'off' } };
const theme = (t: string) => ({ [THEME]: { state: t } });
const asleep = { 'sensor.house_active_mode': { state: 'sleep' } };

// The scene call is always first; startup also appends the retained window publish.
const expectScene = (actions: unknown[], entity_id: string) =>
  expect(actions[0]).toEqual(expect.objectContaining({ service: 'turn_on', target: { entity_id } }));
const expectOnlyScene = (actions: unknown[], entity_id: string) => {
  expectScene(actions, entity_id);
  expect(actions).toHaveLength(1);
};

beforeEach(() => {
  vi.useFakeTimers();
  at('20:00'); // 20:00 — inside the evening window
});

afterEach(() => vi.useRealTimers());

describe('outdoor lighting', () => {
  describe('at sunset', () => {
    it('turns the garden on when the evening window is still open', () => {
      const result = run(sunsetEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'sunset' });
      expectScene(result.actions, ON_SCENE);
    });

    it('stays off when sunset falls at or after 22:00', () => {
      at('22:00');
      const result = run(sunsetEvent, dark);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'no_matching_rule' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('end of the evening', () => {
    it('turns the garden off at 22:00', () => {
      at('22:00');
      const result = run(scheduleOffEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'schedule_off' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('turns the garden off at sunrise in case anything was left on overnight', () => {
      nextDayAt('08:00');
      const result = run(sunriseEvent, light);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'sunrise' });
      expectScene(result.actions, OFF_SCENE);
    });
  });

  describe('when the house goes to sleep', () => {
    it('turns the garden off even though the evening window is still open', () => {
      const result = run(houseModeEvent('sleep'), { ...dark, 'sensor.house_active_mode': { state: 'sleep' } });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'house_sleep_mode' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('does not turn the garden on at sunset if the house is already asleep', () => {
      const result = run(sunsetEvent, { ...dark, ...asleep });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'sunset_while_house_asleep' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('after a restart', () => {
    it('turns the garden on if it is dark and before 22:00', () => {
      const result = run(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'startup_sync' });
      expectScene(result.actions, ON_SCENE);
    });

    it('turns the garden off if it is daytime', () => {
      const result = run(onStartEvent, light);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('turns the garden off if it is dark but past 22:00', () => {
      at('22:30');
      const result = run(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('keeps the garden off if the house is already asleep, even in the evening window', () => {
      const result = run(onStartEvent, { ...dark, ...asleep });
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });
  });

  describe('when automatic lights are switched off for the garden', () => {
    it.each([
      ['sunset', sunsetEvent, dark],
      ['22:00', scheduleOffEvent, dark],
      ['sunrise', sunriseEvent, light],
      ['sleep mode', houseModeEvent('sleep'), dark],
      ['restart', onStartEvent, dark],
      ['a theme change', themeEvent('autumn'), dark],
    ] as const)('leaves the lights alone at %s', (_name, event, sun) => {
      const result = run(event, { ...sun, ...disabled });
      // Only the sunset that should have lit the garden is worth telling anyone about.
      expect(result).toMatchObject(_name === 'sunset'
        ? { decision: 'no_action', reason: 'automation_disabled', outcome: 'declined' }
        : { decision: 'no_action', reason: 'automation_disabled_idle', outcome: 'ignored' });
      expect(result.actions).toEqual([]);
    });

    it('treats a missing toggle helper as switched off rather than acting', () => {
      const { [`input_boolean.${LOCATION}_automation_lights_enabled`]: _, ...stateWithoutToggle } = baseState;
      const result = testAutomation(automation, { event: sunsetEvent, state: { ...stateWithoutToggle, ...dark }, ha: makeHa() });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled', outcome: 'declined' });
    });
  });

  describe('with a theme selected', () => {
    it("turns on in the theme's look at sunset", () => {
      const result = run(sunsetEvent, { ...dark, ...theme('autumn') });
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'sunset' });
      expectScene(result.actions, AUTUMN_SCENE);
    });

    it("restores the theme's look after a restart in the evening", () => {
      const result = run(onStartEvent, { ...dark, ...theme('autumn') });
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'startup_sync' });
      expectScene(result.actions, AUTUMN_SCENE);
    });

    it.each([
      ['22:00', scheduleOffEvent, dark],
      ['sunrise', sunriseEvent, light],
      ['sleep mode', houseModeEvent('sleep'), dark],
    ] as const)('still turns everything off at %s, whatever the theme', (_name, event, sun) => {
      const result = run(event, { ...sun, ...theme('autumn') });
      expect(result.decision).toBe('turn_off');
      expectScene(result.actions, OFF_SCENE);
    });

    it('falls back to the normal look, loudly, when the theme has no scene in this garden yet', () => {
      const result = run(sunsetEvent, { ...dark, ...theme('halloween') });
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'theme_scene_missing' });
      expectScene(result.actions, ON_SCENE);
      expect(result.conditions).toMatchObject({ trigger: 'sunset', theme: 'halloween', themeSceneMissing: true });
    });

    it('says the scene is missing on a theme change and at startup too', () => {
      expect(run(themeEvent('halloween'), { ...dark, ...theme('halloween') })).toMatchObject({ decision: 'turn_on', reason: 'theme_scene_missing' });
      expect(run(onStartEvent, { ...dark, ...theme('halloween') })).toMatchObject({ decision: 'turn_on', reason: 'theme_scene_missing' });
    });

    it.each([
      ['has no theme helper', {}],
      ['has its theme helper unavailable', theme('unavailable')],
    ])('uses the normal look when the garden %s', (_name, themeState) => {
      const { [THEME]: _, ...stateWithoutTheme } = baseState;
      const result = testAutomation(automation, {
        event: sunsetEvent,
        state: { ...stateWithoutTheme, ...dark, ...themeState },
        ha: makeHa(),
      });
      expectScene(result.actions, ON_SCENE);
      expect(result.conditions).toMatchObject({ theme: 'normal', themeSceneMissing: false });
    });
  });

  describe('changing the theme', () => {
    it('restyles the garden straight away when the lights are on', () => {
      const result = run(themeEvent('autumn'), { ...dark, ...theme('autumn') });
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'theme_changed' });
      expectScene(result.actions, AUTUMN_SCENE);
    });

    it('switches back to the normal look when the theme is set back to normal', () => {
      const result = run(themeEvent('normal'), { ...dark, ...theme('normal') });
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'theme_changed' });
      expectScene(result.actions, ON_SCENE);
    });

    it.each([
      ['during the day', light, {}],
      ['after 22:00', dark, {}, '22:30'],
      ['while the house is asleep', dark, asleep],
    ] as const)('does not turn the garden on %s', (_name, sun, extra, time?: string) => {
      if (time) at(time);
      const result = run(themeEvent('autumn'), { ...sun, ...extra, ...theme('autumn') });
      expect(result).toMatchObject({ decision: 'no_action', reason: 'theme_changed_while_off' });
      expect(result.actions).toEqual([]);
    });
  });

  describe('with a later off time for softer accent lighting', () => {
    it('turns off at 22:00 by default', () => {
      expect(automation.triggers).toContainEqual({ type: 'schedule', cron: '0 22 * * *' });
    });

    it('turns off at the configured time instead', () => {
      expect(midnightAutomation.triggers).toContainEqual({ type: 'schedule', cron: '0 0 * * *' });
      expect(midnightAutomation.triggers).not.toContainEqual({ type: 'schedule', cron: '0 22 * * *' });
    });

    it('still turns on at a late sunset that the 22:00 default would have skipped', () => {
      at('22:30');
      const result = runMidnight(sunsetEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'sunset' });
    });

    it('turns the garden off when the off time arrives', () => {
      nextDayAt('00:00');
      const result = runMidnight(scheduleOffEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'schedule_off' });
      expectScene(result.actions, OFF_SCENE);
    });

    it.each([
      ['22:30', at],
      ['23:59', at],
    ] as const)('after a restart at %s, puts the garden back on', (time, setClock) => {
      setClock(time);
      const result = runMidnight(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_on', reason: 'startup_sync' });
    });

    it.each([
      ['00:00', nextDayAt],
      ['00:30', nextDayAt],
      ['03:00', nextDayAt],
      ['06:00', nextDayAt],
    ] as const)('after a restart at %s, keeps the garden off because the window closed at midnight', (time, setClock) => {
      setClock(time);
      const result = runMidnight(onStartEvent, dark);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'startup_sync' });
      expectScene(result.actions, OFF_SCENE);
    });

    it('restyles the garden on a theme change at 23:00, but not at 00:30', () => {
      at('23:00');
      expect(runMidnight(themeEvent('autumn'), { ...dark, ...theme('autumn') })).toMatchObject({ decision: 'turn_on', reason: 'theme_changed' });
      nextDayAt('00:30');
      expect(runMidnight(themeEvent('autumn'), { ...dark, ...theme('autumn') })).toMatchObject({ decision: 'no_action', reason: 'theme_changed_while_off' });
    });

    it('handles an off time after midnight as one continuous evening', () => {
      const lateAutomation = makeOutdoorLightingAutomation({ location: LOCATION, offTime: '01:30' });
      const restartAt = (setClock: typeof at, time: string) => {
        setClock(time);
        return testAutomation(lateAutomation, { event: onStartEvent, state: { ...baseState, ...dark }, ha: makeHa() }).decision;
      };
      expect(restartAt(nextDayAt, '01:29')).toBe('turn_on');
      expect(restartAt(nextDayAt, '01:30')).toBe('turn_off');
      expect(lateAutomation.triggers).toContainEqual({ type: 'schedule', cron: '30 1 * * *' });
    });

    it('refuses a malformed off time at startup rather than guessing', () => {
      expect(() => makeOutdoorLightingAutomation({ location: LOCATION, offTime: '24:00' })).toThrow(/invalid outdoor lighting offTime/);
      expect(() => makeOutdoorLightingAutomation({ location: LOCATION, offTime: '9pm' })).toThrow(/invalid outdoor lighting offTime/);
    });
  });

  describe('scene discovery', () => {
    it("uses only this garden's scenes, ignoring identically-labelled scenes in other areas", () => {
      expectScene(run(sunsetEvent, dark).actions, ON_SCENE);
      expectScene(run(sunsetEvent, { ...dark, ...theme('autumn') }).actions, AUTUMN_SCENE);
    });

    it("does not borrow another garden's theme scene", () => {
      const result = run(sunsetEvent, { ...dark, ...theme('halloween') });
      expectScene(result.actions, ON_SCENE);
    });

    it('aborts when the garden has no on scene configured', () => {
      const result = testAbort(automation, { event: sunsetEvent, state: { ...baseState, ...dark }, ha: makeHa({ omit: 'on' }) });
      expect(result.reason).toEqual(expect.stringContaining('no_on_scene_configured'));
    });

    it('aborts when the garden has no off scene configured', () => {
      const result = testAbort(automation, { event: scheduleOffEvent, state: { ...baseState, ...dark }, ha: makeHa({ omit: 'off' }) });
      expect(result.reason).toEqual(expect.stringContaining('no_off_scene_configured'));
    });
  });
});

// ── Window publish and preview ─────────────────────────────────────────────────

const previewAutomation = makeOutdoorLightingAutomation({ location: LOCATION, offTime: '00:00', previewMinutes: 10 });
const TIMER_KEY = `${LOCATION}:lighting:preview_off`;
const TS_A = '2026-01-07T10:00:00+00:00';
const TS_B = '2026-01-07T11:00:00+00:00';

function sceneEvent(entity_id: string, old: string, next: string) {
  const mk = (state: string) => ({ entity_id, state, attributes: {}, last_changed: '', last_updated: '' });
  return { type: 'state_changed' as const, entity_id, old_state: mk(old), new_state: mk(next), correlation_id: 'test-cid' };
}
const activated = (scene: string) => sceneEvent(scene, TS_A, TS_B);
const reloaded = (scene: string) => sceneEvent(scene, 'unavailable', TS_B);
const timerEvent = { type: 'timer_expired' as const, timerKey: TIMER_KEY, correlation_id: 'test-cid' };

function runPreview(event: unknown, overrideState: Record<string, { state: string }> = {}) {
  return testAutomation(previewAutomation, { event: event as never, state: { ...baseState, ...overrideState }, ha: makeHa() });
}

describe('publishing the window', () => {
  const windowCall = (payload: unknown) =>
    expect.objectContaining({ type: 'mqtt.publish', topic: `${LOCATION}/lighting/window`, retain: true, payload: JSON.stringify(payload) });

  it('publishes the off time and no preview limit on startup, retained', () => {
    const result = runMidnight(onStartEvent, dark);
    expect(result.actions).toContainEqual(windowCall({ off: '00:00', preview_min: null }));
  });

  it('publishes the preview limit when the garden has one', () => {
    const result = runPreview(onStartEvent, light);
    expect(result.actions).toContainEqual(windowCall({ off: '00:00', preview_min: 10 }));
  });

  it('publishes whether the lights are due or not', () => {
    expect(run(onStartEvent, dark).actions).toContainEqual(windowCall({ off: '22:00', preview_min: null }));
    expect(run(onStartEvent, light).actions).toContainEqual(windowCall({ off: '22:00', preview_min: null }));
  });

  it('publishes only on startup', () => {
    expect(run(sunsetEvent, dark).actions.some(a => (a as { type: string }).type === 'mqtt.publish')).toBe(false);
  });
});

describe('previewing a scene outside the evening window', () => {
  beforeEach(() => at('14:00'));

  it('starts a timer for the configured minutes when a theme scene is switched on by day', () => {
    const result = runPreview(activated(AUTUMN_SCENE), light);
    expect(result).toMatchObject({ decision: 'start_preview', reason: 'on_outside_evening_window' });
    expect(result.actions).toEqual([{ type: 'timer.start', timerKey: TIMER_KEY, delayMs: 10 * 60_000 }]);
  });

  it('also previews after the off time', () => {
    at('00:30');
    const result = runPreview(activated(ON_SCENE), dark);
    expect(result).toMatchObject({ decision: 'start_preview' });
  });

  it('previews while the house sleeps in the evening, since the lights are not due', () => {
    at('20:00');
    expect(runPreview(activated(AUTUMN_SCENE), { ...dark, ...asleep })).toMatchObject({ decision: 'start_preview' });
  });

  it('leaves the lights alone in the evening window', () => {
    at('20:00');
    const result = runPreview(activated(AUTUMN_SCENE), dark);
    expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_activated_in_window' });
    expect(result.actions).toEqual([]);
  });

  it('ignores a scenes reload, which only restores old timestamps', () => {
    const result = runPreview(reloaded(AUTUMN_SCENE), light);
    expect(result).toMatchObject({ decision: 'no_action', reason: 'scene_reloaded_not_activated' });
    expect(result.actions).toEqual([]);
  });

  it('does not start a preview for the off scene', () => {
    const result = runPreview(activated(OFF_SCENE), light);
    expect(result.decision).toBe('no_action');
    expect(result.actions).toEqual([]);
  });

  it('does nothing when the automation is disabled', () => {
    const result = runPreview(activated(AUTUMN_SCENE), { ...light, ...disabled });
    expect(result).toMatchObject({ decision: 'no_action', reason: 'automation_disabled_idle', outcome: 'ignored' });
    expect(result.actions).toEqual([]);
  });

  describe('when the preview timer expires', () => {
    it('turns the garden off outside the window', () => {
      const result = runPreview(timerEvent, light);
      expect(result).toMatchObject({ decision: 'turn_off', reason: 'preview_ended' });
      expectOnlyScene(result.actions, OFF_SCENE);
    });

    it('does nothing once sunset has passed, because the normal evening has taken over', () => {
      at('20:00');
      const result = runPreview(timerEvent, dark);
      expect(result).toMatchObject({ decision: 'no_action', reason: 'preview_ended_in_window' });
      expect(result.actions).toEqual([]);
    });

    it('turns off when the preview ran into sleep mode', () => {
      at('20:00');
      expect(runPreview(timerEvent, { ...dark, ...asleep })).toMatchObject({ decision: 'turn_off', reason: 'preview_ended' });
    });

    it('does nothing when the automation is disabled', () => {
      expect(runPreview(timerEvent, { ...light, ...disabled })).toMatchObject({ decision: 'no_action', reason: 'automation_disabled_idle', outcome: 'ignored' });
    });
  });

  describe('configuration', () => {
    it('watches this garden\'s scenes and the preview timer', () => {
      const scenes = previewAutomation.triggers.find(t => t.type === 'state_changed' && t.entity instanceof RegExp);
      expect(scenes).toBeDefined();
      const pattern = (scenes as { entity: RegExp }).entity;
      expect(pattern.test(AUTUMN_SCENE)).toBe(true);
      expect(pattern.test('scene.other_garden_autumn')).toBe(false);
      expect(previewAutomation.triggers).toContainEqual({ type: 'timer_expired', timerKey: TIMER_KEY });
    });

    it('adds no triggers to a garden without a preview limit', () => {
      expect(automation.triggers.some(t => t.type === 'timer_expired')).toBe(false);
      expect(automation.triggers.some(t => t.type === 'state_changed' && t.entity instanceof RegExp)).toBe(false);
    });

    it.each([0, -5, 1.5, Number.NaN])('refuses previewMinutes %s at load', (previewMinutes) => {
      expect(() => makeOutdoorLightingAutomation({ location: LOCATION, previewMinutes })).toThrow(/invalid outdoor lighting previewMinutes/);
    });
  });
});

// ── What each decision says about itself ───────────────────────────────────────

describe('outdoor lighting outcomes and facts', () => {
  const expectDecision = (
    result: { reason?: string; outcome: string; facts?: unknown },
    reason: string, outcome: string, facts?: Record<string, unknown>,
  ) => {
    expect(result).toMatchObject({ reason, outcome });
    expect(result.facts).toEqual(facts);
  };

  it.each([
    ['sunset', () => run(sunsetEvent, dark)],
    ['schedule_off', () => { at('22:00'); return run(scheduleOffEvent, dark); }],
    ['sunrise', () => run(sunriseEvent, light)],
    ['house_sleep_mode', () => run(houseModeEvent('sleep'), dark)],
    ['preview_ended', () => runPreview(timerEvent, light)],
  ] as const)('acts without facts for %s', (reason, go) => {
    expectDecision(go(), reason, 'acted');
  });

  it('acts and names the theme when the theme changes while the lights are due', () => {
    expectDecision(run(themeEvent('autumn'), { ...dark, ...theme('autumn') }), 'theme_changed', 'acted', { theme: 'autumn' });
  });

  it('acts and names the theme when its scene is missing, at sunset, theme change and restart', () => {
    const halloween = { ...dark, ...theme('halloween') };
    expectDecision(run(sunsetEvent, halloween), 'theme_scene_missing', 'acted', { theme: 'halloween' });
    expectDecision(run(themeEvent('halloween'), halloween), 'theme_scene_missing', 'acted', { theme: 'halloween' });
    expectDecision(run(onStartEvent, halloween), 'theme_scene_missing', 'acted', { theme: 'halloween' });
  });

  it('acts and gives the preview length when a scene is switched on outside the evening window', () => {
    expectDecision(runPreview(activated(AUTUMN_SCENE), light), 'on_outside_evening_window', 'acted', { minutes: 10 });
  });

  it('declines when sunset finds the house asleep', () => {
    expectDecision(run(sunsetEvent, { ...dark, ...asleep }), 'sunset_while_house_asleep', 'declined');
  });

  it('declines when the automation is off at sunset, and ignores it on every other trigger', () => {
    expectDecision(run(sunsetEvent, { ...dark, ...disabled }), 'automation_disabled', 'declined');
    expectDecision(run(sunriseEvent, { ...light, ...disabled }), 'automation_disabled_idle', 'ignored');
  });

  it('ignores a restart sync in either direction, since it restores what is already due', () => {
    expectDecision(run(onStartEvent, dark), 'startup_sync', 'ignored');
    expectDecision(run(onStartEvent, light), 'startup_sync', 'ignored');
  });

  it('ignores a theme change while the lights are off', () => {
    expectDecision(run(themeEvent('autumn'), { ...light, ...theme('autumn') }), 'theme_changed_while_off', 'ignored');
  });

  it('ignores the preview timer when sunset has taken over, and a scene switched on in the window', () => {
    expectDecision(runPreview(timerEvent, dark), 'preview_ended_in_window', 'ignored');
    expectDecision(runPreview(activated(AUTUMN_SCENE), dark), 'scene_activated_in_window', 'ignored');
  });

  it('ignores a scenes reload, the off scene, a scene from another area, and a sunset after the off time', () => {
    expectDecision(runPreview(reloaded(AUTUMN_SCENE), light), 'scene_reloaded_not_activated', 'ignored');
    expectDecision(runPreview(activated(OFF_SCENE), light), 'no_matching_rule', 'ignored');
    expectDecision(runPreview(activated('scene.other_garden_all'), light), 'no_matching_rule', 'ignored');
    at('22:30');
    expectDecision(run(sunsetEvent, dark), 'no_matching_rule', 'ignored');
  });
});
