# Migration status

Current state of the Node-RED → homerun migration. When porting a new automation, read `agent_docs/node-red.md` for how to examine the source flow.

---

## Done

**Lighting** — all rooms: bathroom, bedroom, foreign-office, hallway-downstairs, hallway-upstairs, home-office, kitchen, parlour. Factory: `lib/lighting-controller-factory.ts`.

**Occupancy** — hallway-downstairs, hallway-upstairs, kitchen. Factory: `lib/occupancy-controller-factory.ts`. Remaining rooms below.

**Heating** — boiler-demand, trv-actuation, trv-adaptation, window-external, patio-door, room-temp-feed.

**House** — away-detection, camera-mode-sync, guest-mode, manual-privacy-toggle, sleep-mode-button, exit-sleep-button, foreign-office/overtemp-safety.

---

## Todo

### Occupancy — remaining rooms

Use `makeOccupancyAutomation`. Rooms with door contact entities labelled `presence_hold_door` need `extraTriggers` for those contacts.

| Room | Notes |
|------|-------|
| bathroom | No door contacts expected |
| bedroom | No door contacts expected |
| home-office | Check for door contact |
| parlour | Has patio door — likely needs `extraTriggers` |
| foreign-office | Check for door contact |
| back-garden | Motion only, no containment |

### House-level automations

| Automation | Notes |
|---|---|
| WFH Adam / WFH Sarah / WFH Weekend | Clean v3 pipelines, shared tail — currently running in homerun already (WFH); verify what's live |
| Window thermal notifications | Clean v3 pipeline |
| Kitchen Sonos | Independent automation triggered by `binary_sensor.kitchen_occupied`; `input_boolean.kitchen_automation_sonos_enabled` gates it |
| Home Office Sonos | Same pattern as Kitchen |
| Foreign Office heating | Pre-v3 internally — port as a fresh automation; logic is straightforward |
| Cheap rate nudge | `schedule` trigger, reads cheapest window sensor + presence, emits notify action |
| Rates tomorrow notification | `state_changed` on forecast availability sensor, emits notify action |
| Outdoor temp history | `schedule` at 23:00, shifts 7-entry history array, writes to `input_text` |
| Mo/Frigate notifications | Needs `mqtt_in` trigger on Frigate topic; cooldown via timer, camera-to-room mapping |
| Active scene publish | Requires area registry fetch — resolve by writing a template sensor in HA and reading it like any other entity |

---

## Drop

| Flow | Reason |
|---|---|
| Bedroom — Force Sleep Mode inject | Replaced by sleep-mode-button |
| Foreign Office — Global Heating Tick orphan | Dead code, no downstream wires |
| Heating (main tab) | Superseded by Heating (Local) automations above |
| MQTT discovery registration | Infrastructure — replace with a static retained MQTT message |
| Weather hi/lo fetch | Move fetch responsibility into an HA template sensor; homerun reads the helper |
