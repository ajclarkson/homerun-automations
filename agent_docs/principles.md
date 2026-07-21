# Automation design principles

These principles explain the reasoning behind structural decisions. An automation that violates them will likely work in testing and fail in production in ways that are hard to trace.

---

**1. Every decision is observable.**

Every code path through a reducer must return `{ decision, reason, inputs, actions }`. There are no silent no-ops. A suppressed action is still a decision: `decision: 'no_action', reason: 'motion_disabled'` — not a missing return.

`inputs` must include every value that influenced the outcome. If it affected the decision, it belongs in inputs.

---

**2. Context builders read. Reducers decide. Neither does both.**

The context builder's only job is to assemble inputs from state. It never computes outcomes. The reducer's only job is to produce a decision from inputs. It never reads state directly.

If you find yourself calling `state()` inside a reducer, or branching on a decision inside a context builder, the logic is in the wrong place.

---

**3. Compound conditions are named in context, not re-derived in the reducer.**

When a decision depends on combining multiple signals, derive the combination in the context builder, give it a meaningful name, and pass it as a named boolean. The reducer reads the name, not the expression.

```typescript
// context builder:
const guestModeActive = houseModifier === 'guest' && presenceOverride;

// reducer:
if (guestModeActive) { ... }   // not: if (houseModifier === 'guest' && presenceOverride)
```

Named booleans appear in `inputs` and make decision snapshots self-explanatory without reading the code.

---

**4. HA is the configuration layer.**

Behaviour is configured in HA — via labels on entities, `input_boolean` helpers, `input_number` thresholds, and `input_select` options. Automation code discovers and reads configuration at runtime; it never hardcodes entity IDs, thresholds, or room-specific conditions.

If you are about to write a specific entity ID or magic number inside a factory function, it should instead be a label, a helper read via `state()`, or a config parameter on the room file.

---

**5. Cross-room dependencies go through helper entities.**

When one room's automation needs to react to another room's state, the dependency is expressed through a dedicated `input_boolean` helper scoped to the dependent room, carrying a label the factory discovers. A sync automation keeps the helper in sync with the source.

Direct reads of another room's entity inside an automation create hidden coupling invisible to the discovery and observability layers.

---

**6. A wrong decision silently made is always worse than a loud abort.**

When an automation encounters unexpected or missing state, it must abort with a named reason rather than fall through on a default. A room where a light doesn't come on because an automation aborted is a recoverable situation. A room where heating is set to 0°C because a `NaN` was silently treated as `false` is not.

Return `abort('reason')` from the context builder, or include `decision: 'no_action', reason: 'sensor_unavailable'` in the reducer output. Either way, the failure is recorded in observability and visible in Loki. A silent wrong decision leaves no trace.

---

**7. Validate inputs and outputs — assert both what you expect and what you don't.**

Defensive validation has two sides. Assert the positive space (the value is a number, is finite, is within a plausible range) and the negative space (the value is not `NaN`, not negative, not above a physical maximum).

For numeric HA state reads: `Number.isFinite(value)` is the minimum check, not the complete check. A temperature sensor returning `999` is finite but wrong. Clamp or reject values outside a physically plausible range.

For action outputs: before returning an action plan, verify that computed values (topic strings, payload values, timer delays) are well-formed. A topic of `undefined/occupied/state` or a delay of `NaN` milliseconds will execute silently and incorrectly.

---

**8. Clamp all derived numeric values before emitting them as actions.**

Any numeric value that flows from HA state into an action — a setpoint, a delay, a brightness — must be clamped to a known-safe range before it appears in the action plan. Even if upstream validation passed, clamping at the output is a second, independent safety layer.

```typescript
const delayMs = Math.min(Math.max(computedDelay, MIN_DELAY_MS), MAX_DELAY_MS);
```

Define `MIN_*` and `MAX_*` constants at the top of the factory. These bounds are the specification — they document what the automation considers valid and enforce it unconditionally.

---

**9. Guard every numeric state read against NaN.**

`parseFloat(state('sensor.x')?.state)` returns `NaN` when the entity is unavailable. `NaN > 15` is silently `false` — an unavailable sensor becomes indistinguishable from one that hasn't crossed the threshold, with no error and a wrong decision.

Always validate with `Number.isFinite()` before use. If the value is required and missing, abort with a named reason rather than falling through on a silent bad value.

---

**10. Timer keys and MQTT topics follow the naming scheme.**

| Thing | Pattern | Example |
|---|---|---|
| Timer key | `{location}:{purpose}` | `hallway_downstairs:occupied_clear` |
| Timer key (subsystem-scoped) | `{location}:{subsystem}:{purpose}` | `parlour:heating:schedule_boundary` |
| Occupied state topic | `{location}/occupied/state` | `kitchen/occupied/state` |
| Contained state topic | `{location}/occupied/contained/state` | `kitchen/occupied/contained/state` |
| Heating mode topic | `{location}/heating/active` | `parlour/heating/active` |
| Heating source topic | `{location}/heating/source` | `parlour/heating/source` |

Consistent naming makes topics predictable and prevents collisions across rooms. Do not invent new patterns without updating this table.

---

**11. Keep functions under 70 lines. Centralise branching; extract non-branching logic.**

A function longer than 70 lines cannot be read without scrolling. When a function grows past this limit, the fix is structural: the parent owns the branching logic, and repeated non-branching computations move into named helpers.

Duplicated logic is the most common driver of length violations. If the same computation appears twice in a function body, it belongs in a helper — not because of DRY, but because each duplication is a future divergence waiting to happen.

```typescript
// Extracted helper: named, bounded, and independently testable
function planTimer(timerKey: string, validUntilMs: number | null, nowMs: number): Action[] {
  if (validUntilMs === null) return [];
  const delayMs = Math.min(Math.max(validUntilMs - nowMs, MIN_TIMER_DELAY_MS), MAX_TIMER_DELAY_MS);
  return [{ type: 'timer.start', timerKey, delayMs }];
}
```

---

**12. Initialise variables to sentinel values; never leave them in an indeterminate state.**

Declaring `let decision: string` and assigning it conditionally relies on the compiler to prove every path assigns before use. Compilers are fallible and conditions change. Initialise to a sentinel that is observably wrong if it reaches the output:

```typescript
let decision = 'no_action';
let reason = 'uninitialised';
```

If `'uninitialised'` appears in a Loki event, it immediately identifies a code path that failed to set the value — far better than a runtime error or a silently incorrect decision.
