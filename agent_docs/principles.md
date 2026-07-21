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

**6. Guard every numeric state read against NaN.**

`parseFloat(state('sensor.x')?.state)` returns `NaN` when the entity is unavailable. `NaN > 15` is silently `false` — an unavailable sensor becomes indistinguishable from one that hasn't crossed the threshold, with no error and a wrong decision.

Always validate with `Number.isFinite()` before use. If the value is required and missing, abort with a named reason rather than falling through on a silent bad value.

---

**7. Timer keys and MQTT topics follow the naming scheme.**

| Thing | Pattern | Example |
|---|---|---|
| Timer key | `{location}:{purpose}` | `hallway_downstairs:occupied_clear` |
| Occupied state topic | `{location}/occupied/state` | `kitchen/occupied/state` |
| Contained state topic | `{location}/occupied/contained/state` | `kitchen/occupied/contained/state` |

Consistent naming makes topics predictable and prevents collisions across rooms. Do not invent new patterns without updating this table.
