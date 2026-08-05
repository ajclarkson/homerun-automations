# lib/ — shared factory functions

Each file here is a factory (`makeXAutomation(config)`) plus its test file. The factory owns all logic; room files in `{room}/` just pass config.

## Rules for factory authoring

Config parameters are for things that genuinely differ per room (delays, opt-in triggers). Logic that is identical across rooms belongs in the factory body, not duplicated in config callbacks.

Hold entity discovery must use HA labels filtered by area — never hardcode entity IDs inside a factory. Pattern: `ha.entitiesByLabel('some_label').filter(e => ha.entitiesByArea(location).includes(e))`.

`extraTriggers` is the opt-in pattern for per-room trigger variations (e.g. door contacts). Do not add triggers to factory defaults that are not universal across all rooms.

Hold entities discovered dynamically via `entitiesByLabel`/`entitiesByArea` inside `context()` are only *read*, never *listened to* — `triggers` is a static list resolved before any label lookup runs. Every entity carrying a hold label (`presence_hold_strong`, `presence_hold_door`, etc.) that a room actually uses must also be added to that room's `extraTriggers`, or the automation won't re-evaluate when it changes state. Missing this caused `foreign-office/occupancy.ts` to get stuck "occupied" for hours after `binary_sensor.foreign_office_monitor` dropped below its power threshold with no motion/door event to trigger a re-check (2026-08-05).

## Rules for factory tests

Tests live in `{factory-name}.test.ts` alongside the factory. Cover all meaningful input permutations — see `occupancy-controller-factory.test.ts` as the reference.

Describe/it blocks must read as domain behaviour specifications, not code structure labels. A reader should understand what the system does from the test names alone, without reading the implementation.
