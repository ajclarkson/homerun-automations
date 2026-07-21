# Migration status

Current state of the Node-RED → homerun migration. When porting a new automation, read `agent_docs/node-red.md` for how to examine the source flow.

---

## Done

**Lighting** — all rooms: bathroom, bedroom, foreign-office, hallway-downstairs, hallway-upstairs, home-office, kitchen, parlour. Factory: `lib/lighting-controller-factory.ts`. back-garden remaining.

**Occupancy** — all rooms: bathroom, bedroom, foreign-office, hallway-downstairs, hallway-upstairs, home-office, kitchen, parlour. Factory: `lib/occupancy-controller-factory.ts`.

**Heating** — boiler-demand, trv-actuation, trv-adaptation, window-external, patio-door, room-temp-feed, heating-controller (all 7 rooms via `lib/heating-controller-factory.ts`).

**House** — away-detection, camera-mode-sync, guest-mode, manual-privacy-toggle, sleep-mode-button, exit-sleep-button, foreign-office/overtemp-safety.

---

## Todo

### Standalone automations

| Automation | Notes |
|---|---|
| ~~WFH Adam / WFH Sarah / WFH Weekend~~ | Done — `house/wfh.ts`, merged PR #47 |
| Window thermal notifications | Clean v3 pipeline |
| Cheap rate nudge | `schedule` trigger, reads cheapest window sensor + presence, emits notify action |
| Rates tomorrow notification | `state_changed` on forecast availability sensor, emits notify action |
| Outdoor temp history | `schedule` at 23:00, shifts 7-entry history array, writes to `input_text` |
| Mo/Frigate notifications | Needs `mqtt_in` trigger on Frigate topic; cooldown via timer, camera-to-room mapping |
| back-garden lighting | Lighting controller — check Node-RED config for any back-garden specific behaviour |

---

## Drop

| Flow | Reason |
|---|---|
| Bedroom — Force Sleep Mode inject | Replaced by sleep-mode-button |
| Foreign Office — Global Heating Tick orphan | Dead code, no downstream wires |
| Heating (main tab) | Superseded by Heating (Local) automations above |
| MQTT discovery registration | Infrastructure — replace with a static retained MQTT message |
| Weather hi/lo fetch | Move fetch responsibility into an HA template sensor; homerun reads the helper |
