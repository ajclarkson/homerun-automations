# Examining existing Node-RED flows

Read this file when porting an automation from Node-RED to homerun.

## Accessing flows

`flows.json` at the root of `~/workspace/claude-home` is a sync of the live Node-RED instance. Pull a fresh copy if you need it to be current:

```bash
cd ~/workspace/claude-home && ./nr.sh sync
```

## Finding a room's automation config

Subflow instances carry their per-room config in `env`. To find the config for a specific room and controller:

```bash
cat flows.json | python3 -c "
import json, sys
flows = json.load(sys.stdin)
tabs = {n['id']: n['label'] for n in flows if n.get('type') == 'tab'}
for n in flows:
    if 'occ_v3_runtime_v1' in n.get('type', ''):  # change subflow type as needed
        tab = tabs.get(n.get('z', ''), '?')
        print(tab, json.dumps(n.get('env', [])))
"
```

Key subflow type suffixes: `occ_v3_runtime_v1`, `sf_lighting_v3_runtime`, `heating_v3_runtime_v1`.

## Reading the function node logic

The decision logic lives in function nodes inside the subflow definition. To extract it:

```bash
cat flows.json | python3 -c "
import json, sys
flows = json.load(sys.stdin)
subflow = next(n for n in flows if n.get('type') == 'subflow' and 'Occupancy' in n.get('name', ''))
fn_nodes = [n for n in flows if n.get('z') == subflow['id'] and n.get('type') == 'function']
for n in fn_nodes:
    print('---', n.get('name'))
    print(n.get('func', ''))
"
```

## What to look for when porting

- **`env` params** → factory config fields (e.g. `delayMins`)
- **`context.get/set`** → use MQTT-retained HA sensors instead (homerun has no persistent in-memory context across pod restarts)
- **Gate nodes** → early returns in the reducer
- **Subflow wiring order** → branch priority in the reducer

The migration audit at `~/workspace/claude-home/homerun-migration-audit.md` records the status of every pipeline and any porting notes.
