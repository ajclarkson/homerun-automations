# homerun-automations — Context

## What this is

The private consumer repo for the homerun framework. All household automations live here — no framework code, no HA infrastructure, just automation definitions for the Clarkson home.

Framework lives at `~/workspace/homerun` and is linked via `"homerun": "file:../homerun"`.

## Running the dev server

```bash
# From ~/workspace/homerun — start with automations pointed here
AUTOMATIONS_DIR=../homerun-automations DRY_RUN=true npm run dev
```

Hot reload is active — saving any `.ts` file in this repo triggers esbuild re-bundle and re-registration without a process restart.

## Writing automations

```typescript
import { defineAutomation, abort } from 'homerun';

export default defineAutomation({
  id: 'room:subsystem',
  location: 'room',
  subsystem: 'subsystem_name',
  triggers: [
    { type: 'schedule', cron: '0 8 * * 1-5' },
    { type: 'state_changed', entity: 'binary_sensor.some_sensor' },
  ],
  context: (state, ha) => {
    if (someGuard) return abort('reason');
    return { field, inputs: { field } };
  },
  reduce: (ctx) => ({
    decision: 'on',
    reason: 'some_reason',
    inputs: ctx.inputs,
    actions: [
      { type: 'ha.call_service', domain: 'input_boolean', service: 'turn_on',
        target: { entity_id: 'input_boolean.some_flag' } },
    ],
  }),
});
```

`context` receives `(state, ha)` — `state(entityId)` returns the current HA entity state, `ha` provides `entitiesByLabel`, `labelsFor`, `entitiesByArea`. Return `abort('reason')` to short-circuit — no reduce call, observability records the abort.

Entity state includes `last_changed` and `last_updated` (ISO strings). Use `Date.parse(entity.last_changed)` for timestamp comparisons; guard with `Number.isFinite()` per design principle 20.

`inputs` in the context return and reducer output feeds the MQTT decision snapshot — include everything that influenced the decision.

## Multi-room controllers (factory pattern)

For controllers shared across rooms (occupancy, lighting, heating), use a factory function and array default export:

```typescript
// shared/occupancy-controller.ts
function makeOccupancyAutomation(room: string, triggers: Trigger[]) {
  return defineAutomation({
    id: `${room}:occupancy`,
    location: room,
    subsystem: 'occupancy',
    triggers,
    context: (state) => { /* shared logic */ },
    reduce: (ctx) => ({ /* shared logic */ }),
  });
}

export default [
  { room: 'parlour', triggers: [{ type: 'state_changed', entity: 'binary_sensor.parlour_sensor_motion' }] },
  { room: 'kitchen', triggers: [{ type: 'state_changed', entity: 'binary_sensor.kitchen_sensor_motion' }] },
].map(({ room, triggers }) => makeOccupancyAutomation(room, triggers));
```

Note: array default export support is tracked as homerun issue #54 and not yet implemented. Until then, use one file per room.

## Codegen

Entity types are generated from live HA state:

```bash
npm run codegen   # writes types/ha-entities.ts
```

Import from `./types/ha-entities.js` in automations for typed entity IDs.

## Testing

`testAutomation` from `@ajclarkson/homerun/testing` accepts partial state entries:

```typescript
state: {
  'binary_sensor.foo': { state: 'on', last_changed: new Date(Date.now() - 5000).toISOString() },
}
```

`last_changed` and `last_updated` are optional — they default to `''` if omitted. Omitting them is fine for automations that don't read timestamps.

## Structure

```
house/
  away-detection.ts — sets/clears away mode via zone.home + door recency
bedroom/
  bed-occupancy-sync.ts — syncs bed occupancy to hallway helper
types/
  ha-entities.ts    — Generated entity types (do not edit)
```

## Household context

- Residents: Adam, Sarah
- WFH helpers: `input_boolean.wfh_adam`, `input_boolean.wfh_sarah`
- Workday sensor: `binary_sensor.workday_sensor` (UK bank holiday-aware — always prefer this over hardcoding weekdays)
- House mode: `sensor.house_active_mode`
- Entity naming follows strict conventions — see `~/workspace/claude-home/CLAUDE.md`
