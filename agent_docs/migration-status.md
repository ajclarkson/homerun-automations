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

Migration complete. Nothing remaining.

### Done

| Automation | Notes |
|---|---|
| WFH Adam / WFH Sarah / WFH Reset | `house/wfh.ts`, merged PR #47 |
| Cheap rate nudge | `house/octopus-rates.ts`, merged PR #48 |
| Rates tomorrow notification | `house/octopus-rates.ts`, merged PR #48 |
| Window thermal notifications | `house/window-thermal.ts`, merged PR #49 |
| Foreign Office door ventilation | `foreign-office/door-ventilation.ts`, merged PR #50 |
| Outdoor temp history | `house/outdoor-temp-history.ts`, merged PR #51 |
| Mo/Frigate notifications | `house/mo-frigate.ts`, merged PR #52 |
| Back-garden lighting | `back-garden/`, lighting controller |

---

## Drop

| Flow | Reason |
|---|---|
| Bedroom — Force Sleep Mode inject | Replaced by sleep-mode-button |
| Foreign Office — Global Heating Tick orphan | Dead code, no downstream wires |
| Heating (main tab) | Superseded by Heating (Local) automations above |
| MQTT discovery registration | Infrastructure — replace with a static retained MQTT message |
| Weather hi/lo fetch | Move fetch responsibility into an HA template sensor; homerun reads the helper |
