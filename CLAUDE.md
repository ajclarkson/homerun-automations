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
- `lib/outdoor-lighting-factory.ts` — `makeOutdoorLightingAutomation(config)` (gardens: on at sunset in the selected theme's scene, off at `offTime` (default 22:00) / sunrise / sleep; optional `previewMinutes` turns a scene switched on outside the evening window off again after that long; startup publishes the retained `{location}/lighting/window`; a theme with no scene gives reason `theme_scene_missing`)
- `lib/theme-effects-factory.ts` — `makeThemeEffectsAutomation(config)` (on-bulb Hue effects per theme, by `outdoor_light_feature` / `outdoor_light_accent` role labels, while the theme's scene is active)
- `lib/porch-light-factory.ts` — `makePorchLightAutomation(config)` (porch light labelled `outdoor_light_porch`: saves its look in `input_text.<location>_automation_porch_restore`, fades to a warm look on motion after dark, fades back to that look (plain light.turn_on, since scene.turn_on snaps on this bulb) after the `input_number.<location>_automation_porch_hold` quiet time)
- `lib/theme-calendar.ts` — `makeThemeCalendarAutomation(config)` (sets `input_select.<location>_light_theme` from a yearly calendar on the days its answer changes; manual picks stick until then; every run publishes the retained `{location}/lighting/theme_calendar` with today's theme, the next change and unknown themes, deciding `publish_calendar` when it does not switch)

Room files that use a factory are typically 3-5 lines. All logic lives in the factory; the room file only passes config.

## How to write tests

Use `testAutomation` from `@ajclarkson/homerun/testing`. Tests live alongside the file they test (e.g. `lib/occupancy-controller-factory.test.ts`).

Write tests from domain intent, not code structure. Describe blocks should read like behaviour specifications, not branch labels. Every meaningful permutation of inputs should be covered — see `lib/occupancy-controller-factory.test.ts` as the reference example.

## Before writing an automation

Read `agent_docs/principles.md` — these are the rules that produce correct behaviour under real conditions. Read `~/workspace/homerun/docs/api.md` for the full trigger, action, and testing API.

## What not to do

- Every automation declares its reasons (`reasons: { <reason>: { outcome, facts? } }` in `defineAutomation`); `lib/all-declared.test.ts` fails on one that does not. Outcomes: `acted` (a person would notice: a mode change, a device on or off, a notification, a boiler call), `declined` (a rule chose not to act and a person would want to know why), `ignored` (heartbeats, syncs, "already in state", bookkeeping; never stored in history). Reason names and fact keys are static identifiers: split a rule whose outcome depends on the trigger into two reasons, and use `null` for an unknown fact, never omit it. Tests resolve each decision with `testDeclared` from `lib/declared-outcome.ts` so an undeclared reason or wrong fact fails the test.

- Do not hardcode entity IDs or room names inside shared factory functions — they must be derived from `location` config or discovered via HA labels.
- Do not use `initial:` on HA helpers — it breaks state persistence across restarts.
- Array default exports are supported — a file may export `defineAutomation(...)[]` when one logical concern produces multiple automations (e.g. one per room). Each automation in the array must still have a unique `id`.
