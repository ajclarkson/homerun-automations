# homerun-automations

Household automations for the Clarkson home, built on the [homerun](https://github.com/ajclarkson/homerun) framework.

This repo contains only automation definitions — no framework code. Homerun handles the runtime: state cache, trigger engine, observability, and hot reload.

## Structure

```
back-garden/    outdoor lighting
bathroom/       lighting, occupancy, heating
bedroom/        lighting, occupancy, heating, sleep mode bypass
foreign-office/ lighting, occupancy, heating, door ventilation, overtemp safety
hallway-*/      lighting, occupancy, heating
heating/        boiler demand, TRV actuation/adaptation, window-external, patio-door, room temp feed
home-office/    lighting, occupancy, heating, Sonos
house/          away detection, camera mode sync, guest mode, sleep mode, WFH inference,
                Octopus rate nudges, window thermal notifications, Mo/Frigate cat tracking
kitchen/        lighting, occupancy, heating, Sonos
lib/            shared factory functions (lighting, occupancy, heating, Sonos)
parlour/        lighting, occupancy, heating
types/          generated HA entity types
```

Most rooms are 3–5 lines — they pass config to a factory in `lib/`. All logic lives in the factory.

## Running

```bash
npm test           # run the full test suite (vitest)
npm run codegen    # regenerate types/ha-entities.ts from live HA state
```

Hot reload is active in production. Saving any `.ts` file re-bundles without restarting the process.

## How automations are structured

Every automation follows the same shape:

```typescript
defineAutomation({
  id: 'location:name',
  triggers: [...],
  context: (state, ha, event) => { /* read state, return inputs */ },
  reduce:  (ctx) => { /* decide and return actions */ },
});
```

`context` reads. `reduce` decides. Neither does both. Every code path returns `{ decision, reason, inputs, actions }` — there are no silent no-ops.

For rooms that share the same behaviour (lighting, occupancy, heating, Sonos), factory functions in `lib/` own all the logic. A room file looks like this:

```typescript
// kitchen/lighting.ts
export default makeLightingAutomation({ location: 'kitchen' });
```

Standalone automations (anything in `house/`, `heating/`, `foreign-office/door-ventilation.ts`) are single-purpose files that own their own logic.

## Design principles

The rules that make automations correct under real conditions are in [`agent_docs/principles.md`](agent_docs/principles.md). The full trigger, action, and testing API is in [`agent_docs/framework.md`](agent_docs/framework.md).

The short version: guard every numeric read, clamp every numeric output, abort on unexpected state rather than falling through on a default, and make every decision observable.
