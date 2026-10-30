# homerun-automations

Private consumer repo for the homerun automation framework. All household automations for the Clarkson home live here. No framework code — just automation definitions.

Framework: `@ajclarkson/homerun`, installed from npm (pinned to an `edge` build); source at `~/workspace/homerun`. Entity naming and cross-repo design rules are in `~/workspace/homeOS/docs/` (`naming.md`, `architecture.md`); code-level principles are in `agent_docs/principles.md`.

## How to build and test

```bash
npm test          # run vitest test suite — always do this before committing
npm run codegen   # regenerate types/ha-entities.ts from live HA state (run if entity types are stale)
```

Hot reload is active in production — saving any `.ts` file triggers re-bundle without a process restart. No manual deploy step.

## How to add an automation

One file per automation, in a directory named after the room or subsystem (e.g. `kitchen/`, `house/`). Export the automation as default.

For controllers that are identical across rooms (lighting, occupancy, heating), use the factory functions in `lib/`:

- `lib/lighting-controller-factory.ts` — `makeLightingAutomation(config)`
- `lib/occupancy-controller-factory.ts` — `makeOccupancyAutomation(config)`
- `lib/outdoor-lighting-factory.ts` — `makeOutdoorLightingAutomation(config)` (gardens: on at sunset in the selected theme's scene, off at `offTime` (default 22:00) / sunrise / sleep)
- `lib/theme-effects-factory.ts` — `makeThemeEffectsAutomation(config)` (on-bulb Hue effects per theme, by `outdoor_light_feature` / `outdoor_light_accent` role labels, while the theme's scene is active)
- `lib/theme-calendar.ts` — `makeThemeCalendarAutomation(config)` (sets `input_select.<location>_light_theme` from a yearly calendar on the days its answer changes; manual picks stick until then)

Room files that use a factory are typically 3-5 lines. All logic lives in the factory; the room file only passes config.

## How to write tests

Use `testAutomation` from `@ajclarkson/homerun/testing`. Tests live alongside the file they test (e.g. `lib/occupancy-controller-factory.test.ts`).

Write tests from domain intent, not code structure. Describe blocks should read like behaviour specifications, not branch labels. Every meaningful permutation of inputs should be covered — see `lib/occupancy-controller-factory.test.ts` as the reference example.

## Before writing an automation

Read `agent_docs/principles.md` — these are the rules that produce correct behaviour under real conditions. Read `~/workspace/homerun/docs/api.md` for the full trigger, action, and testing API.

## What not to do

- Do not hardcode entity IDs or room names inside shared factory functions — they must be derived from `location` config or discovered via HA labels.
- Do not use `initial:` on HA helpers — it breaks state persistence across restarts.
- Array default exports are supported — a file may export `defineAutomation(...)[]` when one logical concern produces multiple automations (e.g. one per room). Each automation in the array must still have a unique `id`.
