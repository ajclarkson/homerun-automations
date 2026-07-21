# homerun-automations

Private consumer repo for the homerun automation framework. All household automations for the Clarkson home live here. No framework code — just automation definitions.

Framework lives at `~/workspace/homerun` (linked via `"@ajclarkson/homerun": "file:../homerun"`). Design principles and entity naming conventions are in `~/workspace/claude-home/CLAUDE.md`.

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

Room files that use a factory are typically 3-5 lines. All logic lives in the factory; the room file only passes config.

## How to write tests

Use `testAutomation` from `@ajclarkson/homerun/testing`. Tests live alongside the file they test (e.g. `lib/occupancy-controller-factory.test.ts`).

Write tests from domain intent, not code structure. Describe blocks should read like behaviour specifications, not branch labels. Every meaningful permutation of inputs should be covered — see `lib/occupancy-controller-factory.test.ts` as the reference example.

## Before writing an automation

Read `agent_docs/principles.md` — these are the rules that produce correct behaviour under real conditions. Read `agent_docs/framework.md` for the full trigger, action, and testing API.

## Porting from an existing flow

When the task involves examining or porting an existing automation, read `agent_docs/migration-status.md` to understand what's done and what's next, and `agent_docs/node-red.md` for how to examine the source flow.

## What not to do

- Do not reference Node-RED in source code or comments. Migration history belongs in PR descriptions.
- Do not hardcode entity IDs or room names inside shared factory functions — they must be derived from `location` config or discovered via HA labels.
- Do not use `initial:` on HA helpers — it breaks state persistence across restarts.
- Array default exports are not yet supported by the framework. One automation per file.
