#!/usr/bin/env node
// Strips entities that leak raw network identifiers (e.g. unidentified UniFi
// device_trackers named after MAC addresses) from the generated HA entity
// types before the file is committed to this public repo.
import { readFileSync, writeFileSync } from 'node:fs';

const path = new URL('../types/ha-entities.ts', import.meta.url);
const lines = readFileSync(path, 'utf8').split('\n');

const filtered = lines.filter((line) => !/'device_tracker\.unifi_default_/.test(line));

writeFileSync(path, filtered.join('\n'));

const removed = lines.length - filtered.length;
if (removed > 0) {
  console.log(`Filtered ${removed} unidentified device_tracker entit${removed === 1 ? 'y' : 'ies'} from types/ha-entities.ts`);
}
