# Homerun framework — consumer reference

The framework lives at `~/workspace/homerun`. This covers what you need to write and test automations here — not framework internals.

## Trigger types

```typescript
{ type: 'state_changed'; entity: string | RegExp }
{ type: 'timer_expired'; timerKey: string }
{ type: 'button'; entity: string | RegExp; gesture: 'single_press' | 'double_press' | 'hold' }
{ type: 'schedule'; cron: string }
{ type: 'mqtt_in'; topic: string }
{ type: 'on_start' }
```

`on_start` fires once after the state cache is populated on startup. Use it to establish initial state.

## Action types

```typescript
{ type: 'ha.call_service'; domain: string; service: string; target?: { entity_id: string }; data?: Record<string, unknown> }
{ type: 'mqtt.publish'; topic: string; payload: string; retain?: boolean }
{ type: 'timer.start'; timerKey: string; delayMs: number }
{ type: 'timer.cancel'; timerKey: string }
```

## Context builder arguments

```typescript
context: (state, ha, event) => { ... }
```

- `state(entityId)` — returns `{ state: string; last_changed: string; last_updated: string } | undefined` from the live HA state cache
- `ha.entitiesByLabel(label)` — entity IDs carrying that label (from HA entity registry, loaded at startup)
- `ha.entitiesByArea(area)` — entity IDs in that area
- `ha.labelsFor(entityId)` — labels on a specific entity
- `event` — the raw trigger event; inspect `event.type` to determine which trigger fired

All three are synchronous. `ha.*` reads from the registry snapshot, not live HA. Return `abort('reason')` to short-circuit — the abort is recorded in observability and `reduce` is never called.

## Testing

```typescript
import { testAutomation } from '@ajclarkson/homerun/testing';

const result = testAutomation(automation, {
  event: { type: 'state_changed', entity_id: 'binary_sensor.foo', new_state: { state: 'on' } },
  state: {
    'binary_sensor.foo': { state: 'on' },
    'input_boolean.bar': { state: 'off', last_changed: new Date(Date.now() - 5000).toISOString() },
  },
  ha: {
    entitiesByLabel: (l) => l === 'some_label' ? ['input_boolean.bar'] : [],
    entitiesByArea: () => ['binary_sensor.foo', 'input_boolean.bar'],
    labelsFor: () => [],
  },
});

expect(result).toMatchObject({ decision: 'no_action', reason: 'some_reason' });
expect(result.actions).toEqual([]);
```

`state` entries only need the fields your automation reads. `last_changed`/`last_updated` default to `''` if omitted — only include them when the automation reads timestamps.
