import { defineAutomation, HomeAssistant } from '@ajclarkson/homerun';

const LOCATION = 'back_garden';
const ON_SCENE = 'scene.back_garden_all';
const OFF_SCENE = 'scene.back_garden_off';

type LightingTrigger = 'sunset' | 'sunrise' | 'schedule_off' | 'system';

interface BackGardenLightingContext {
  trigger: LightingTrigger;
  automationEnabled: boolean;
  inOnWindow: boolean;
  inputs: Record<string, unknown>;
}

export default defineAutomation<BackGardenLightingContext>({
  id: `${LOCATION}:lighting`,
  location: LOCATION,
  subsystem: 'lighting',

  triggers: [
    { type: 'state_changed', entity: 'sun.sun', to: 'below_horizon' },
    { type: 'state_changed', entity: 'sun.sun', to: 'above_horizon' },
    { type: 'schedule', cron: '0 22 * * *' },
    { type: 'on_start' },
  ],

  context: (state, _ha, event) => {
    let trigger: LightingTrigger;
    if (event.type === 'state_changed' && event.entity_id === 'sun.sun') {
      trigger = event.new_state.state === 'below_horizon' ? 'sunset' : 'sunrise';
    } else if (event.type === 'schedule') {
      trigger = 'schedule_off';
    } else {
      trigger = 'system';
    }

    const automationEnabled = state(`input_boolean.${LOCATION}_automation_lights_enabled`)?.state === 'on';
    const sunBelowHorizon = state('sun.sun')?.state === 'below_horizon';
    const hourNow = new Date().getHours();
    const inOnWindow = sunBelowHorizon && hourNow < 22;

    return {
      trigger,
      automationEnabled,
      inOnWindow,
      inputs: { trigger, automationEnabled, inOnWindow, sunBelowHorizon, hourNow },
    };
  },

  reduce: (ctx) => {
    const { trigger, automationEnabled, inOnWindow } = ctx;

    if (!automationEnabled) {
      return { decision: 'no_action', reason: 'automation_disabled', inputs: ctx.inputs, actions: [] };
    }

    if (trigger === 'sunset' && inOnWindow) {
      return {
        decision: 'turn_on',
        reason: 'sunset',
        inputs: ctx.inputs,
        actions: [HomeAssistant.scene.turn_on({ entity_id: ON_SCENE }, { transition: 0.5 })],
      };
    }

    if (trigger === 'schedule_off' || trigger === 'sunrise') {
      return {
        decision: 'turn_off',
        reason: trigger,
        inputs: ctx.inputs,
        actions: [HomeAssistant.scene.turn_on({ entity_id: OFF_SCENE }, { transition: 0.5 })],
      };
    }

    if (trigger === 'system') {
      const scene = inOnWindow ? ON_SCENE : OFF_SCENE;
      return {
        decision: inOnWindow ? 'turn_on' : 'turn_off',
        reason: 'startup_sync',
        inputs: ctx.inputs,
        actions: [HomeAssistant.scene.turn_on({ entity_id: scene }, { transition: 0.5 })],
      };
    }

    return { decision: 'no_action', reason: 'no_matching_rule', inputs: ctx.inputs, actions: [] };
  },
});
